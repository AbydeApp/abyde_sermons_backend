import type { TranscriptSegmentRecord } from '../../domain/sermon-intelligence.js';

/** Guardrails shared by every sermon-grounded prompt. */
export const GUARDRAILS = [
  'Rules you must follow:',
  '- Use only what is in the provided sermon material. Do not invent events, teachings, or claims.',
  '- Never invent or alter Bible verses. Cite only references that exist; if unsure, omit the reference.',
  '- Never fabricate quotations or attribute your own wording to the pastor.',
  '- Write in plain, warm language suitable for a church audience.',
].join('\n');

const MAX_TRANSCRIPT_CHARS = 180_000;

export const formatTimestamp = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, '0');
  return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`;
};

/**
 * Renders numbered segments for a prompt. Very long transcripts are evenly sampled so the
 * request stays within the model's context budget while still covering the whole sermon.
 */
export function buildTranscriptContext(
  segments: TranscriptSegmentRecord[],
  maxChars = MAX_TRANSCRIPT_CHARS,
): string {
  const lines = segments.map(
    (segment) =>
      `[${segment.sequence}] (${formatTimestamp(segment.startTimeMs)}) ${segment.text}`,
  );
  const total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  if (total <= maxChars) return lines.join('\n');
  const keepRatio = maxChars / total;
  const kept: string[] = [];
  let budget = 0;
  lines.forEach((line, index) => {
    budget += keepRatio;
    if (budget >= 1 || index === 0) {
      kept.push(line);
      budget -= 1;
    }
  });
  return kept.join('\n');
}
