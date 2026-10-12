import { segmentWords, type TimedText } from '../../brand/domain/captions.js';

export interface SentenceWord {
  text: string;
  startMs: number;
  endMs: number;
}

/** One spoken sentence: the unit Reel boundaries snap to, so a Reel never starts or ends mid-thought. */
export interface Sentence {
  index: number;
  text: string;
  startMs: number;
  endMs: number;
}

const SENTENCE_END = /[.!?]["'”’)\]]*$/;
/** Preachers often run sentences together; a long pause or a very long run also ends a unit. */
const PAUSE_BREAK_MS = 1_200;
const MAX_SENTENCE_WORDS = 45;

/**
 * Splits a transcript into timed sentences. Uses real word timings where the transcript has them
 * (frame-accurate boundaries) and estimated timings otherwise.
 */
export function toSentences(segments: TimedText[]): Sentence[] {
  const words: SentenceWord[] = [...segments]
    .sort((a, b) => a.startTimeMs - b.startTimeMs)
    .flatMap((segment) => segmentWords(segment));
  const sentences: Sentence[] = [];
  let current: SentenceWord[] = [];
  const flush = () => {
    const first = current[0];
    const last = current[current.length - 1];
    if (first && last)
      sentences.push({
        index: sentences.length,
        text: current.map((word) => word.text).join(' '),
        startMs: Math.round(first.startMs),
        endMs: Math.round(Math.max(last.endMs, first.startMs)),
      });
    current = [];
  };
  for (const word of words) {
    const previous = current[current.length - 1];
    if (previous && word.startMs - previous.endMs >= PAUSE_BREAK_MS) flush();
    current.push(word);
    if (SENTENCE_END.test(word.text) || current.length >= MAX_SENTENCE_WORDS)
      flush();
  }
  flush();
  return sentences;
}
