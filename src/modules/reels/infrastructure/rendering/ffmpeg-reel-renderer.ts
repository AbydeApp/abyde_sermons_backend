import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PermanentJobError } from '../../../../shared/application/jobs.js';
import { runProcess } from '../../../../shared/infrastructure/process/run-process.js';
import { buildThumbnailArgs } from '../../../brand/infrastructure/rendering/ffmpeg-clip-args.js';
import type {
  ProbedVideo,
  ReelRendererPort,
  RenderedReel,
  RenderReelInput,
} from '../../application/ports/out/reel.ports.js';
import { buildReelAss } from './reel-ass.js';
import { buildReelArgs } from './reel-ffmpeg-args.js';

const ENCODE_TIMEOUT_MS = 20 * 60 * 1000;
const PROBE_TIMEOUT_MS = 60 * 1000;
const OVERLAY_FILE = 'reel.ass';

interface ProbeOutput {
  streams?: Array<{
    codec_type?: string;
    width?: number;
    height?: number;
    tags?: { rotate?: string };
    side_data_list?: Array<{ rotation?: number }>;
  }>;
  format?: { duration?: string };
}

/** Parses ffprobe JSON; phone videos stored rotated report their displayed (rotated) size. */
export function parseProbe(json: string): ProbedVideo {
  const parsed = JSON.parse(json) as ProbeOutput;
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  if (!video?.width || !video.height)
    throw new PermanentJobError(
      'Source has no video stream',
      'This sermon file has no video to make a Reel from.',
    );
  const rotation = Math.abs(
    Number(
      video.side_data_list?.find((data) => data.rotation !== undefined)
        ?.rotation ??
        video.tags?.rotate ??
        0,
    ),
  );
  const swapped = rotation % 180 === 90;
  return {
    width: swapped ? video.height : video.width,
    height: swapped ? video.width : video.height,
    durationMs: Math.round(Number(parsed.format?.duration ?? 0) * 1000),
    hasAudio: Boolean(
      parsed.streams?.some((stream) => stream.codec_type === 'audio'),
    ),
  };
}

/**
 * FFmpeg + libass Reel renderer: one encode that cuts, reframes, cleans up the real audio and burns
 * in the animated hook, captions, labels, logo and outro. Remotion-style templates can replace it
 * behind the same port without touching the application.
 */
export class FfmpegReelRenderer implements ReelRendererPort {
  constructor(
    private readonly ffmpegPath: string,
    private readonly ffprobePath: string,
  ) {}

  async probe(path: string, signal?: AbortSignal): Promise<ProbedVideo> {
    const output = await runProcess(
      this.ffprobePath,
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        '-show_entries',
        'stream=codec_type,width,height:stream_tags=rotate:stream_side_data=rotation:format=duration',
        '-of',
        'json',
        path,
      ],
      { timeoutMs: PROBE_TIMEOUT_MS, signal },
    ).catch((error: unknown) => {
      signal?.throwIfAborted();
      throw new PermanentJobError(
        `ffprobe failed: ${(error as Error).message}`,
        'We could not read the sermon video.',
      );
    });
    return parseProbe(output);
  }

  async render(input: RenderReelInput): Promise<RenderedReel> {
    const clipMs = input.endMs - input.startMs;
    await input.onStage('ADDING_HOOK');
    await input.onStage('ADDING_CAPTIONS');
    await input.onStage('BRANDING');
    await writeFile(
      join(input.workDir, OVERLAY_FILE),
      buildReelAss({
        width: input.width,
        height: input.height,
        clipMs,
        font: input.brand.headingFont,
        primaryColor: input.brand.primaryColor,
        accentColor: input.brand.accentColor,
        hook: input.hook,
        captions: input.captions,
        labels: input.labels,
        logoPosition: input.logoPosition,
        outro: input.outro,
      }),
    );
    await input.onStage('ENCODING');
    const outputPath = join(input.workDir, 'reel.mp4');
    try {
      await runProcess(
        this.ffmpegPath,
        buildReelArgs({
          sourcePath: input.sourcePath,
          outputPath,
          startMs: input.startMs,
          endMs: input.endMs,
          width: input.width,
          height: input.height,
          sourceHeight: input.source.height,
          hasAudio: input.source.hasAudio,
          crop: input.crop,
          assFile: OVERLAY_FILE,
          logoPath: input.logoPath,
          logoPosition: input.logoPosition,
          outroMs: input.outro?.durationMs ?? 0,
          outroColor: input.brand.primaryColor,
        }),
        {
          timeoutMs: ENCODE_TIMEOUT_MS,
          cwd: input.workDir,
          signal: input.signal,
        },
      );
    } catch (error) {
      input.signal?.throwIfAborted();
      throw new PermanentJobError(
        `ffmpeg reel encode failed: ${(error as Error).message}`,
        'We could not render this Reel from the sermon video.',
      );
    }
    const rendered = await this.probe(outputPath, input.signal);
    // Cover frame: inside the hook when there is one (so the hook text is on the thumbnail).
    const coverMs = input.hook
      ? Math.min(Math.round(input.hook.durationMs * 0.6), clipMs - 1)
      : Math.min(1_000, clipMs - 1);
    const thumbnailPath = join(input.workDir, 'reel-thumb.jpg');
    await runProcess(
      this.ffmpegPath,
      buildThumbnailArgs({
        videoPath: outputPath,
        outputPath: thumbnailPath,
        atMs: Math.max(0, coverMs),
      }),
      { timeoutMs: PROBE_TIMEOUT_MS, signal: input.signal },
    );
    return {
      filePath: outputPath,
      contentType: 'video/mp4',
      width: rendered.width,
      height: rendered.height,
      durationMs: rendered.durationMs,
      thumbnail: {
        filePath: thumbnailPath,
        contentType: 'image/jpeg',
        width: input.width,
        height: input.height,
      },
    };
  }
}
