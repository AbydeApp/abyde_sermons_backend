import type {
  TranscriptionPort,
  TranscriptionResult,
} from './ports.js';

const SAMPLE = [
  'Good morning church. Please open your Bibles with me to Hebrews 11:1.',
  'Now faith is confidence in what we hope for and assurance about what we do not see.',
  'This morning we are talking about walking by faith and not by sight.',
  'Paul tells us in 2 Corinthians 5:7 that we live by faith, not by sight.',
  'Faith is not the absence of questions. Faith is trusting God in the middle of them.',
  'I remember when our family moved to Lagos with no job and no plan, only a promise.',
  'God did not show us the whole road, but He gave us enough light for the next step.',
  'Romans 8:28 reminds us that in all things God works for the good of those who love Him.',
  'So this week, I want you to take one step of obedience you have been putting off.',
  'Trust is built one step at a time, and every step is an act of worship.',
  'Let us pray that God would give us courage to walk where we cannot yet see.',
  'May the Lord bless you and keep you as you walk by faith this week. Amen.',
];

/** Deterministic dev/test transcription: a short sermon spread across the media duration, with word timings. */
export class FakeTranscriptionAdapter implements TranscriptionPort {
  async transcribe(input: {
    durationMs: number;
  }): Promise<TranscriptionResult> {
    const repeats = 4;
    const lines = Array.from({ length: repeats }, () => SAMPLE).flat();
    const step = Math.max(
      1000,
      Math.floor((input.durationMs || 600_000) / lines.length),
    );
    return {
      provider: 'fake',
      language: 'en',
      fragments: lines.map((text, index) => {
        const startMs = index * step;
        const tokens = text.split(/\s+/);
        const perWord = step / tokens.length;
        return {
          text,
          startMs,
          endMs: startMs + step,
          words: tokens.map((token, position) => ({
            text: token,
            startMs: Math.round(startMs + position * perWord),
            endMs: Math.round(startMs + (position + 1) * perWord),
          })),
        };
      }),
    };
  }
}
