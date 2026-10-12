import { Logger } from '@nestjs/common';
import type {
  PublishInput,
  PublishMedia,
} from '../../../application/ports/out/social-publishing.port.js';
import {
  asSocialProviderError,
  SocialProviderError,
} from '../../../domain/social-errors.js';
import { YOUTUBE_PRIVACY } from '../../../domain/target-settings.js';
import type { LocalMedia, MediaFiles } from '../shared/media-download.js';
import {
  bearer,
  type SocialHttpRequest,
  type SocialHttpResponse,
} from '../shared/social-http.client.js';
import {
  YOUTUBE_UPLOAD_URL,
  type YouTubeApiClient,
} from './youtube-api.client.js';
import { mapGoogleError } from './youtube.errors.js';
import type {
  YouTubePrivacyStatus,
  YouTubeVideo,
  YouTubeVideoResource,
} from './youtube.types.js';

const KIB = 1024;
const MIB = 1024 * KIB;
/** Google requires every chunk but the last to be a multiple of 256 KiB. */
export const CHUNK_GRANULARITY_BYTES = 256 * KIB;
export const DEFAULT_CHUNK_SIZE_BYTES = 8 * MIB;
/**
 * Per chunk PUT (8 MiB in 5 minutes is ~28 KB/s, far below any real link). The whole upload must
 * still fit the `social-publish` job time limit, which is why capabilities cap the video size.
 */
const CHUNK_TIMEOUT_MS = 5 * 60_000;
const MAX_THUMBNAIL_BYTES = 2 * MIB;
const MAX_TITLE_CHARS = 100;
const MAX_DESCRIPTION_BYTES = 5000;
/** YouTube's budget for all tags together (a tag containing a space counts its quotes too). */
const MAX_TAGS_CHARS = 500;
/**
 * People & Blogs: YouTube's own default for uploads and assignable in every region. Nonprofits &
 * Activism (29) would describe a church better but is not assignable everywhere; the church can
 * change the category in YouTube Studio.
 */
const CATEGORY_PEOPLE_AND_BLOGS = '22';
/**
 * Asks Google's upload front end to answer "Resume Incomplete" as 200 + this override header
 * instead of a 308, which `fetch` would treat as a redirect (and the shared HTTP client refuses
 * redirects). Google's own Go client library does the same.
 */
const NO_308_HEADER = { 'X-GUploader-No-308': 'yes' };
const STATUS_OVERRIDE_HEADER = 'x-http-status-code-override';

export type UploadedVideo = YouTubeVideo & { id: string };

export type ThumbnailResult =
  { thumbnail: 'set' } | { thumbnail: 'failed'; thumbnailError: string };

interface UploadRequest {
  token: string;
  video: PublishMedia;
  resource: YouTubeVideoResource;
  signal?: AbortSignal;
}

/**
 * Resumable upload of one video (`videos.insert`) streamed from scratch disk in chunks, plus the
 * optional custom thumbnail. Only the final chunk is decisive: YouTube creates the video when the
 * last byte arrives, so an earlier failure leaves nothing behind (the abandoned session expires).
 * One attempt per request; a failed upload is restarted from scratch by the queue's retry.
 */
export class YouTubeUploadService {
  private readonly logger = new Logger('Social:youtube');

  constructor(
    private readonly api: YouTubeApiClient,
    private readonly media: MediaFiles,
    private readonly chunkSizeBytes: number = DEFAULT_CHUNK_SIZE_BYTES,
  ) {
    if (
      !Number.isInteger(chunkSizeBytes) ||
      chunkSizeBytes <= 0 ||
      chunkSizeBytes % CHUNK_GRANULARITY_BYTES !== 0
    )
      throw new Error(
        'YouTube chunk size must be a positive multiple of 256 KiB',
      );
  }

  async uploadVideo(upload: UploadRequest): Promise<UploadedVideo> {
    const state: { video?: UploadedVideo; decisiveSent: boolean } = {
      decisiveSent: false,
    };
    try {
      await this.media.withLocalFile(
        upload.video.objectKey,
        upload.signal,
        async (file) => {
          if (file.sizeBytes === 0)
            throw new SocialProviderError(
              'INVALID_MEDIA',
              'The video file is empty',
            );
          const session = await this.openSession(upload, file.sizeBytes);
          state.video = await this.sendChunks(upload, session, file, () => {
            state.decisiveSent = true;
          });
        },
      );
    } catch (error) {
      if (state.video) {
        // Only scratch-disk cleanup can fail after the upload; the video exists regardless.
        this.logger.warn(
          { operation: 'youtube.upload', detail: (error as Error)?.message },
          'Scratch cleanup failed after a completed upload',
        );
        return state.video;
      }
      if (error instanceof SocialProviderError) throw error;
      if (state.decisiveSent) throw asSocialProviderError(error, true);
      // Reading the stored object failed before YouTube was asked to create anything.
      throw new SocialProviderError(
        'PROVIDER_UNAVAILABLE',
        `youtube.upload: could not read the stored video: ${(error as Error)?.message ?? 'unknown'}`,
        { retryable: true },
      );
    }
    if (!state.video)
      throw asSocialProviderError(
        new Error('upload finished without a video'),
        true,
      );
    return state.video;
  }

  /**
   * Best effort, after the video exists: a custom thumbnail needs a verified channel, and its
   * failure must never turn a published video into a failed publication.
   */
  async setThumbnail(
    token: string,
    videoId: string,
    thumbnail: PublishMedia,
    signal?: AbortSignal,
  ): Promise<ThumbnailResult> {
    try {
      await this.media.withLocalFile(
        thumbnail.objectKey,
        signal,
        async (file) => {
          if (file.sizeBytes === 0 || file.sizeBytes > MAX_THUMBNAIL_BYTES)
            throw new SocialProviderError(
              'INVALID_MEDIA',
              `Thumbnail size ${file.sizeBytes} bytes is outside YouTube's 2 MB limit`,
            );
          await this.api.request({
            operation: 'youtube.thumbnail_set',
            method: 'POST',
            url: `${YOUTUBE_UPLOAD_URL}/thumbnails/set?${new URLSearchParams({ videoId, uploadType: 'media' }).toString()}`,
            headers: {
              ...bearer(token),
              'Content-Type': thumbnail.mimeType,
              'Content-Length': String(file.sizeBytes),
            },
            body: file.stream(),
            signal,
          });
        },
      );
      return { thumbnail: 'set' };
    } catch (error) {
      const code =
        error instanceof SocialProviderError ? error.code : 'UNKNOWN';
      this.logger.warn(
        { operation: 'youtube.thumbnail_set', errorCode: code },
        'Custom thumbnail not set; the video is published without it',
      );
      return { thumbnail: 'failed', thumbnailError: code };
    }
  }

  /** Opens the resumable session with the video metadata. Not decisive: no bytes, no video. */
  private async openSession(
    upload: UploadRequest,
    sizeBytes: number,
  ): Promise<string> {
    const { headers } = await this.api.request<unknown>({
      operation: 'youtube.upload_start',
      method: 'POST',
      url: `${YOUTUBE_UPLOAD_URL}/videos?uploadType=resumable&part=snippet,status`,
      headers: {
        ...bearer(upload.token),
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(sizeBytes),
        'X-Upload-Content-Type': upload.video.mimeType || 'video/*',
      },
      body: JSON.stringify(upload.resource),
      signal: upload.signal,
    });
    const location = headers.get('location');
    // The token goes to the session URI next: it must be Google's upload host, over HTTPS.
    if (!location || !isGoogleUploadUrl(location))
      throw new SocialProviderError(
        'PROVIDER_UNAVAILABLE',
        'youtube.upload_start: missing or unexpected upload session URI',
        { retryable: true },
      );
    return location;
  }

  private async sendChunks(
    upload: UploadRequest,
    sessionUri: string,
    file: LocalMedia,
    markDecisive: () => void,
  ): Promise<UploadedVideo> {
    const total = file.sizeBytes;
    let offset = 0;
    for (;;) {
      const end = Math.min(offset + this.chunkSizeBytes, total) - 1;
      const final = end === total - 1;
      const request: SocialHttpRequest = {
        operation: final
          ? 'youtube.upload_final_chunk'
          : 'youtube.upload_chunk',
        method: 'PUT',
        url: sessionUri,
        headers: {
          ...bearer(upload.token),
          ...NO_308_HEADER,
          'Content-Type': upload.video.mimeType || 'video/*',
          'Content-Length': String(end - offset + 1),
          'Content-Range': `bytes ${offset}-${end}/${total}`,
        },
        body: file.stream(offset, end),
        // The last byte creates the video: a lost answer to this request is an unknown outcome.
        decisive: final,
        timeoutMs: CHUNK_TIMEOUT_MS,
        signal: upload.signal,
      };
      if (final) markDecisive();
      const response = await this.api.http.send(request);

      if (isResumeIncomplete(response)) {
        const next = nextOffset(response.headers.get('range'));
        if (next >= total)
          // Every byte is acknowledged yet the upload is not complete: cannot tell what YouTube did.
          throw new SocialProviderError(
            'PROVIDER_UNAVAILABLE',
            `${request.operation}: upload incomplete after all ${total} bytes were acknowledged`,
            { outcome: 'unknown' },
          );
        if (next <= offset)
          // YouTube kept none of this chunk. Nothing exists yet; the queue restarts the upload.
          throw new SocialProviderError(
            'PROVIDER_UNAVAILABLE',
            `${request.operation}: no progress at byte ${offset} of ${total}`,
            { retryable: true },
          );
        offset = next;
        continue;
      }
      if (!response.ok) throw this.fail(response, request);

      const video = response.json as YouTubeVideo | null;
      if (!video?.id)
        throw new SocialProviderError(
          'UNKNOWN',
          `${request.operation}: ${response.status} without a video id`,
          { outcome: 'unknown', httpStatus: response.status },
        );
      if (
        video.status?.uploadStatus === 'rejected' ||
        video.status?.uploadStatus === 'failed'
      )
        throw new SocialProviderError(
          'INVALID_MEDIA',
          `${request.operation}: upload ${video.status.uploadStatus} (${video.status.rejectionReason ?? video.status.failureReason ?? 'no reason'})`,
          { httpStatus: response.status },
        );
      return { ...video, id: video.id };
    }
  }

  private fail(
    response: SocialHttpResponse,
    request: SocialHttpRequest,
  ): SocialProviderError {
    const error = mapGoogleError(response, request);
    this.logger.warn(
      {
        operation: request.operation,
        status: response.status,
        errorCode: error.code,
        outcome: error.outcome,
        detail: error.message.slice(0, 300),
      },
      'Provider call failed',
    );
    return error;
  }
}

/** Builds the `videos.insert` metadata from the publication, within YouTube's limits. */
export function toVideoResource(input: PublishInput): YouTubeVideoResource {
  const title = truncateChars(
    singleLine(input.title?.trim() || firstLine(input.text ?? '')),
    MAX_TITLE_CHARS,
  ).trim();
  if (!title)
    throw new SocialProviderError(
      'UNSUPPORTED_CONTENT',
      'A YouTube video needs a title',
    );
  if (typeof input.settings.madeForKids !== 'boolean')
    throw new SocialProviderError(
      'UNSUPPORTED_CONTENT',
      'YouTube needs an explicit made-for-kids answer',
    );
  const privacy = input.settings.privacyStatus;
  return {
    snippet: {
      title,
      description: truncateBytes(
        stripAngles(input.text ?? ''),
        MAX_DESCRIPTION_BYTES,
      ),
      tags: fitTags(input.settings.tags),
      categoryId: CATEGORY_PEOPLE_AND_BLOGS,
    },
    status: {
      // Private unless the user chose otherwise: never more visible than asked.
      privacyStatus: YOUTUBE_PRIVACY.includes(privacy as YouTubePrivacyStatus)
        ? (privacy as YouTubePrivacyStatus)
        : 'private',
      selfDeclaredMadeForKids: input.settings.madeForKids,
    },
  };
}

const isResumeIncomplete = (response: SocialHttpResponse): boolean =>
  response.status === 308 ||
  response.headers.get(STATUS_OVERRIDE_HEADER) === '308';

/** `Range: bytes=0-524287` → 524288; no header means YouTube has kept nothing yet. */
const nextOffset = (range: string | null): number => {
  const match = range ? /bytes=\d+-(\d+)/.exec(range) : null;
  return match?.[1] ? Number(match[1]) + 1 : 0;
};

const isGoogleUploadUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' && url.hostname.endsWith('.googleapis.com')
    );
  } catch {
    return false;
  }
};

/** YouTube rejects `<` and `>` in titles, descriptions and tags. */
const stripAngles = (value: string): string => value.replace(/[<>]/g, '');
const singleLine = (value: string): string =>
  stripAngles(value).replace(/\s+/g, ' ');
const firstLine = (value: string): string =>
  value
    .split('\n')
    .find((line) => line.trim())
    ?.trim() ?? '';

/** Truncates by Unicode code points, never splitting a surrogate pair. */
const truncateChars = (value: string, max: number): string => {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('');
};

/** Truncates to a UTF-8 byte budget on a code point boundary. */
const truncateBytes = (value: string, maxBytes: number): string => {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let bytes = 0;
  let out = '';
  for (const char of value) {
    bytes += Buffer.byteLength(char);
    if (bytes > maxBytes) break;
    out += char;
  }
  return out;
};

/** Keeps tags in order until YouTube's combined length budget is spent. */
const fitTags = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  const tags: string[] = [];
  let used = 0;
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const tag = singleLine(value.replace(/,/g, ' ')).trim();
    if (!tag) continue;
    const cost =
      Array.from(tag).length +
      (tag.includes(' ') ? 2 : 0) +
      (tags.length ? 1 : 0);
    if (used + cost > MAX_TAGS_CHARS) break;
    tags.push(tag);
    used += cost;
  }
  return tags;
};
