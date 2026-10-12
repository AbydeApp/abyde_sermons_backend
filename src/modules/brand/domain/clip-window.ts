import { validationError } from '../../../shared/domain/domain-error.js';

export const MIN_CLIP_MS = 5_000;
/** Without an explicit window, a clip is the first minute of the content's sermon passage. */
export const DEFAULT_CLIP_MS = 60_000;

/**
 * Decides which part of the sermon a clip covers: the window the user asked for, else the passage
 * the content was generated from (its source timestamps), clamped to the allowed length.
 */
export function resolveClipWindow(input: {
  requested?: { startMs: number; endMs: number };
  source: { startTimeMs: number | null; endTimeMs: number | null };
  sermonDurationMs: number | null;
  maxClipMs: number;
}): { startMs: number; endMs: number } {
  const limit = input.sermonDurationMs ?? Number.POSITIVE_INFINITY;
  if (input.requested) {
    const { startMs, endMs } = input.requested;
    if (startMs < 0 || endMs <= startMs)
      throw validationError('clip', 'The clip must end after it starts');
    if (endMs - startMs < MIN_CLIP_MS)
      throw validationError('clip', 'Clips must be at least 5 seconds long');
    if (endMs - startMs > input.maxClipMs)
      throw validationError(
        'clip',
        `Clips can be at most ${Math.round(input.maxClipMs / 1000)} seconds long`,
      );
    if (endMs > limit)
      throw validationError('clip', 'The clip ends after the sermon does');
    return { startMs, endMs };
  }
  const { startTimeMs, endTimeMs } = input.source;
  if (startTimeMs === null || endTimeMs === null)
    throw validationError(
      'clip',
      'This content has no sermon timestamps; choose the start and end of the clip',
    );
  const startMs = Math.max(0, startTimeMs);
  const endMs = Math.min(
    endTimeMs,
    limit,
    startMs + Math.min(DEFAULT_CLIP_MS, input.maxClipMs),
  );
  if (endMs - startMs < MIN_CLIP_MS)
    throw validationError(
      'clip',
      'The sermon passage for this content is too short for a clip',
    );
  return { startMs, endMs };
}
