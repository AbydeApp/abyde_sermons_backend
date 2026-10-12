import type { TimedText } from '../../../domain/captions.js';

export const SERMON_MEDIA = Symbol('SERMON_MEDIA');

export interface SermonVideoSource {
  /** Private storage key of the original sermon upload. */
  objectKey: string;
  contentType: string;
  durationMs: number | null;
  /** Set once the retention sweep removed the original upload. */
  removedAt: Date | null;
}

/** Read access to a sermon's original media and transcript timings, scoped to the church. */
export interface SermonMediaPort {
  /** The sermon's source video, or null when it was uploaded as audio, a document or text. */
  findVideoSource(
    churchId: string,
    sermonId: string,
  ): Promise<SermonVideoSource | null>;
  transcriptTimings(churchId: string, sermonId: string): Promise<TimedText[]>;
}
