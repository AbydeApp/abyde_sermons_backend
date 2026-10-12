export interface TimedWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface TimedText {
  startTimeMs: number;
  endTimeMs: number;
  text: string;
  /** Real word timings (absolute) when transcription provided them. */
  words?: TimedWord[];
}

export interface CaptionCue {
  /** Relative to the start of the clip. */
  startMs: number;
  endMs: number;
  text: string;
  /** Each word's timing relative to the clip (drives word-by-word caption styles). */
  words?: TimedWord[];
}

const MAX_CUE_CHARS = 34;
const MAX_CUE_WORDS = 6;
const MIN_CUE_MS = 400;

/**
 * Words of a segment with their timings: the transcription's real word timings when present,
 * otherwise estimated from each word's share of the segment's characters (close to speech, but not
 * frame-accurate).
 */
export function segmentWords(segment: TimedText): TimedWord[] {
  if (segment.words && segment.words.length > 0)
    return segment.words.filter((word) => word.text.trim().length > 0);
  const tokens = segment.text.trim().split(/\s+/).filter(Boolean);
  const weight = tokens.reduce((sum, token) => sum + token.length + 1, 0);
  const duration = segment.endTimeMs - segment.startTimeMs;
  if (weight === 0 || duration <= 0) return [];
  const words: TimedWord[] = [];
  let cursor = segment.startTimeMs;
  for (const token of tokens) {
    const span = (duration * (token.length + 1)) / weight;
    words.push({ text: token, startMs: cursor, endMs: cursor + span });
    cursor += span;
  }
  return words;
}

/** Builds short caption cues for a clip from transcript segments (word timings where available). */
export function buildCaptionCues(
  segments: TimedText[],
  clipStartMs: number,
  clipEndMs: number,
): CaptionCue[] {
  const words: TimedWord[] = [];
  for (const segment of [...segments].sort(
    (a, b) => a.startTimeMs - b.startTimeMs,
  )) {
    if (segment.endTimeMs <= clipStartMs || segment.startTimeMs >= clipEndMs)
      continue;
    for (const word of segmentWords(segment)) {
      const midpoint = (word.startMs + word.endMs) / 2;
      if (midpoint >= clipStartMs && midpoint < clipEndMs) words.push(word);
    }
  }

  const cues: CaptionCue[] = [];
  let current: typeof words = [];
  const flush = () => {
    const first = current[0];
    const last = current[current.length - 1];
    if (!first || !last) return;
    const startMs = Math.max(0, Math.round(first.startMs - clipStartMs));
    const endMs = Math.min(
      clipEndMs - clipStartMs,
      Math.max(startMs + MIN_CUE_MS, Math.round(last.endMs - clipStartMs)),
    );
    if (endMs > startMs)
      cues.push({
        startMs,
        endMs,
        text: current.map((word) => word.text).join(' '),
        words: current.map((word) => ({
          text: word.text,
          startMs: Math.max(0, Math.round(word.startMs - clipStartMs)),
          endMs: Math.min(
            clipEndMs - clipStartMs,
            Math.round(word.endMs - clipStartMs),
          ),
        })),
      });
    current = [];
  };
  for (const word of words) {
    const length =
      current.reduce((sum, item) => sum + item.text.length + 1, 0) +
      word.text.length;
    if (
      current.length > 0 &&
      (current.length >= MAX_CUE_WORDS || length > MAX_CUE_CHARS)
    )
      flush();
    current.push(word);
    if (/[.!?]["'”’)]*$/.test(word.text)) flush();
  }
  flush();
  // Cues never overlap: a cue ends where the next one begins.
  for (let i = 0; i < cues.length - 1; i++) {
    const cue = cues[i];
    const next = cues[i + 1];
    if (cue && next && cue.endMs > next.startMs) cue.endMs = next.startMs;
  }
  // Word timings stay inside their cue, so word-by-word styles never draw outside it.
  for (const cue of cues)
    cue.words = cue.words?.map((word) => {
      const startMs = Math.min(Math.max(word.startMs, cue.startMs), cue.endMs);
      return {
        ...word,
        startMs,
        endMs: Math.min(Math.max(word.endMs, startMs), cue.endMs),
      };
    });
  return cues.filter((cue) => cue.endMs > cue.startMs);
}
