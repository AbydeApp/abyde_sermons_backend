import { segmentTranscript } from './transcript-segmenter.js';

describe('segmentTranscript', () => {
  it('groups timed fragments into ~45s+ segments at sentence boundaries', () => {
    const fragments = Array.from({ length: 12 }, (_, i) => ({
      text: `Sentence number ${i + 1} about faith.`,
      startMs: i * 10_000,
      endMs: (i + 1) * 10_000,
    }));
    const segments = segmentTranscript(fragments);
    expect(
      segments.map((s) => [s.sequence, s.startTimeMs, s.endTimeMs]),
    ).toEqual([
      [1, 0, 50_000],
      [2, 50_000, 100_000],
      [3, 100_000, 120_000],
    ]);
  });

  it('never exceeds the hard cap when a speaker does not end sentences', () => {
    const fragments = Array.from({ length: 30 }, (_, i) => ({
      text: 'and so we keep going',
      startMs: i * 10_000,
      endMs: (i + 1) * 10_000,
    }));
    expect(
      segmentTranscript(fragments).every(
        (s) => s.endTimeMs - s.startTimeMs <= 120_000,
      ),
    ).toBe(true);
  });

  it('estimates monotonically increasing timestamps for untimed text', () => {
    const text = Array.from(
      { length: 40 },
      (_, i) => `This is sentence ${i} of the pasted sermon transcript text.`,
    ).join(' ');
    const segments = segmentTranscript([{ text }]);
    expect(segments.length).toBeGreaterThan(1);
    segments.forEach((segment, index) => {
      expect(segment.endTimeMs).toBeGreaterThan(segment.startTimeMs);
      if (index > 0)
        expect(segment.startTimeMs).toBe(segments[index - 1]?.endTimeMs);
    });
  });

  it('cleans whitespace and drops empty fragments', () => {
    const segments = segmentTranscript([
      { text: '  Grace   and peace .', startMs: 0, endMs: 2000 },
      { text: '   ', startMs: 2000, endMs: 3000 },
    ]);
    expect(segments).toEqual([
      {
        sequence: 1,
        startTimeMs: 0,
        endTimeMs: 2000,
        text: 'Grace and peace.',
      },
    ]);
  });

  it('keeps word timings when every fragment of a segment has them', () => {
    const word = (text: string, startMs: number) => ({
      text,
      startMs,
      endMs: startMs + 400,
    });
    const segments = segmentTranscript([
      {
        text: 'Walk by faith.',
        startMs: 0,
        endMs: 1_200,
        words: [word('Walk', 0), word('by', 400), word('faith.', 800)],
      },
      {
        text: 'Not by sight.',
        startMs: 1_200,
        endMs: 2_400,
        words: [word('Not', 1_200), word('by', 1_600), word('sight.', 2_000)],
      },
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.words?.map((w) => w.text)).toEqual([
      'Walk',
      'by',
      'faith.',
      'Not',
      'by',
      'sight.',
    ]);
  });

  it('drops word timings for a segment when part of it has none', () => {
    const segments = segmentTranscript([
      {
        text: 'Walk by faith.',
        startMs: 0,
        endMs: 1_200,
        words: [{ text: 'Walk', startMs: 0, endMs: 400 }],
      },
      { text: 'Not by sight.', startMs: 1_200, endMs: 2_400 },
    ]);
    expect(segments[0]?.words).toBeUndefined();
  });
});
