import { attachWords } from './openai-transcription.adapter.js';
import { FakeTranscriptionAdapter } from './fake-transcription.adapter.js';

describe('attachWords', () => {
  it('assigns words to the segment their midpoint falls in, and edge words to the nearest', () => {
    const buckets = attachWords(
      [
        { startMs: 0, endMs: 1_000 },
        { startMs: 1_000, endMs: 2_000 },
      ],
      [
        { text: 'a', startMs: 100, endMs: 300 },
        { text: 'b', startMs: 900, endMs: 1_300 },
        { text: 'c', startMs: 1_950, endMs: 2_200 },
      ],
    );
    expect(buckets.map((bucket) => bucket.map((word) => word.text))).toEqual([
      ['a'],
      ['b', 'c'],
    ]);
  });
});

describe('FakeTranscriptionAdapter', () => {
  it('returns word timings inside each fragment', async () => {
    const result = await new FakeTranscriptionAdapter().transcribe({
      durationMs: 480_000,
    });
    for (const fragment of result.fragments) {
      expect(fragment.words?.length).toBe(fragment.text.split(' ').length);
      expect(fragment.words?.[0]?.startMs).toBe(fragment.startMs);
      expect(fragment.words?.at(-1)?.endMs).toBeLessThanOrEqual(fragment.endMs);
    }
  });
});
