/** One spoken word with its position in the sermon (milliseconds from the start). */
export interface TranscriptWord {
  text: string;
  startMs: number;
  endMs: number;
}

/** Raw transcription output: timed fragments from speech-to-text, or untimed document text. */
export interface TranscriptFragment {
  text: string;
  startMs?: number;
  endMs?: number;
  /** Word-level timings when the provider returns them. */
  words?: TranscriptWord[];
}

export interface SegmentDraft {
  sequence: number;
  startTimeMs: number;
  endTimeMs: number;
  text: string;
  /** Present only when every fragment in the segment came with word timings. */
  words?: TranscriptWord[];
}

type TimedFragment = Required<Omit<TranscriptFragment, 'words'>> &
  Pick<TranscriptFragment, 'words'>;

const TARGET_MIN_MS = 45_000;
const HARD_MAX_MS = 120_000;
const MAX_WORDS = 280;
/** Average preaching pace (~150 words per minute) used to estimate positions in untimed text. */
const MS_PER_WORD = 400;

const SENTENCE_END = /[.!?]["')\]]?$/;

export function cleanText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

const wordCount = (text: string): number => (text.match(/\S+/g) ?? []).length;

/** Splits untimed text into sentence fragments with estimated timestamps. */
function estimateTiming(fragments: TranscriptFragment[]): TimedFragment[] {
  const sentences = fragments
    .flatMap((fragment) =>
      cleanText(fragment.text).split(/(?<=[.!?])\s+(?=[A-Z0-9"'“])/),
    )
    .filter((sentence) => sentence.length > 0);
  let cursor = 0;
  return sentences.map((text) => {
    const startMs = cursor;
    cursor += Math.max(1, wordCount(text)) * MS_PER_WORD;
    return { text, startMs, endMs: cursor };
  });
}

/**
 * Groups fragments into readable, citeable segments (~45–120 s), breaking at sentence boundaries.
 * Segments are the unit of evidence: generated content and search results cite them by id + timestamps.
 */
export function segmentTranscript(
  fragments: TranscriptFragment[],
): SegmentDraft[] {
  const timed = fragments.every(
    (fragment) =>
      fragment.startMs !== undefined && fragment.endMs !== undefined,
  );
  const items: TimedFragment[] = timed
    ? fragments
        .map((fragment) => ({
          text: cleanText(fragment.text),
          startMs: fragment.startMs ?? 0,
          endMs: fragment.endMs ?? 0,
          words: fragment.words
            ?.map((word) => ({ ...word, text: word.text.trim() }))
            .filter(
              (word) => word.text.length > 0 && word.endMs >= word.startMs,
            ),
        }))
        .filter((fragment) => fragment.text.length > 0)
        .sort((a, b) => a.startMs - b.startMs)
    : estimateTiming(fragments);

  const segments: SegmentDraft[] = [];
  let buffer: TimedFragment[] = [];
  const flush = () => {
    if (buffer.length === 0) return;
    const first = buffer[0];
    const last = buffer[buffer.length - 1];
    if (first && last) {
      // Word timings are kept only when the whole segment has them, so they always cover its text.
      const words = buffer.every((fragment) => fragment.words?.length)
        ? buffer.flatMap((fragment) => fragment.words ?? [])
        : undefined;
      segments.push({
        sequence: segments.length + 1,
        startTimeMs: Math.round(first.startMs),
        endTimeMs: Math.round(Math.max(last.endMs, first.startMs)),
        text: buffer.map((fragment) => fragment.text).join(' '),
        ...(words
          ? {
              words: words.map((word) => ({
                text: word.text,
                startMs: Math.round(word.startMs),
                endMs: Math.round(word.endMs),
              })),
            }
          : {}),
      });
    }
    buffer = [];
  };

  for (const item of items) {
    buffer.push(item);
    const first = buffer[0];
    const duration = first ? item.endMs - first.startMs : 0;
    const words = wordCount(buffer.map((fragment) => fragment.text).join(' '));
    const atSentenceEnd = SENTENCE_END.test(item.text);
    if (
      (duration >= TARGET_MIN_MS && atSentenceEnd) ||
      duration >= HARD_MAX_MS ||
      words >= MAX_WORDS
    )
      flush();
  }
  flush();
  return segments;
}

export const totalWords = (segments: SegmentDraft[]): number =>
  segments.reduce((sum, segment) => sum + wordCount(segment.text), 0);
