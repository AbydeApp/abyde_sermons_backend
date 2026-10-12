import { planCropPath, MAX_KEYFRAMES } from './crop-path.js';
import {
  type CandidateProposal,
  selectReelCandidates,
  weightedScore,
} from './reel-candidates.js';
import {
  applyReelEdit,
  approveReel,
  needsRender,
  normalizeHookText,
  queueRender,
  type Reel,
  validateHook,
  validateWindow,
} from './reel.js';
import { toSentences } from './transcript-sentences.js';

/** Twenty 6-second sentences with real word timings. */
const transcript = () => {
  const segments = [];
  for (let i = 0; i < 20; i++) {
    const startMs = i * 6_000;
    const words = ['This', 'is', 'sentence', `${i + 1}.`].map((text, w) => ({
      text,
      startMs: startMs + w * 1_400,
      endMs: startMs + w * 1_400 + 1_200,
    }));
    segments.push({
      startTimeMs: startMs,
      endTimeMs: startMs + 6_000,
      text: words.map((word) => word.text).join(' '),
      words,
    });
  }
  return segments;
};

const proposal = (
  startSentence: number,
  endSentence: number,
  score = 8,
): CandidateProposal => ({
  startSentence,
  endSentence,
  title: `Moment ${startSentence}`,
  reason: 'Stands alone.',
  scores: {
    standalone: score,
    impact: score,
    quotability: score,
    contextIndependence: score,
  },
});

describe('toSentences', () => {
  it('splits on sentence punctuation using real word timings', () => {
    const sentences = toSentences(transcript());
    expect(sentences).toHaveLength(20);
    expect(sentences[2]).toEqual({
      index: 2,
      text: 'This is sentence 3.',
      startMs: 12_000,
      endMs: 17_400,
    });
  });

  it('breaks run-on speech at long pauses', () => {
    const sentences = toSentences([
      {
        startTimeMs: 0,
        endTimeMs: 5_000,
        text: 'and so we pray and we wait',
        words: [
          { text: 'and', startMs: 0, endMs: 300 },
          { text: 'so', startMs: 300, endMs: 600 },
          { text: 'we', startMs: 600, endMs: 900 },
          { text: 'pray', startMs: 900, endMs: 1_300 },
          // 2 s pause
          { text: 'and', startMs: 3_300, endMs: 3_600 },
          { text: 'we', startMs: 3_600, endMs: 3_900 },
          { text: 'wait', startMs: 3_900, endMs: 4_400 },
        ],
      },
    ]);
    expect(sentences.map((sentence) => sentence.text)).toEqual([
      'and so we pray',
      'and we wait',
    ]);
  });

  it('estimates timings when the transcript has no word timings', () => {
    const sentences = toSentences([
      { startTimeMs: 0, endTimeMs: 4_000, text: 'Faith works. Love lasts.' },
    ]);
    expect(sentences).toHaveLength(2);
    expect(sentences[0]?.startMs).toBe(0);
    expect(sentences[1]?.endMs).toBe(4_000);
  });
});

describe('selectReelCandidates', () => {
  const sentences = toSentences(transcript());
  const rules = {
    minMs: 15_000,
    maxMs: 40_000,
    maxCandidates: 10,
    maxOverlap: 0.3,
  };

  it('snaps to whole sentences with breathing room and uses the real transcript text', () => {
    const [candidate] = selectReelCandidates(
      [proposal(2, 5)],
      sentences,
      rules,
      120_000,
    );
    expect(candidate).toMatchObject({
      rank: 1,
      // 150 ms lead-in, clamped to the end of the previous sentence (11 400 ms).
      startMs: 11_850,
      // Last word of sentence 6 ends at 35 400 ms, plus a 400 ms tail.
      endMs: 35_800,
      transcript:
        'This is sentence 3. This is sentence 4. This is sentence 5. This is sentence 6.',
    });
  });

  it('extends short moments and trims long ones by whole sentences', () => {
    const [short] = selectReelCandidates([proposal(0, 0)], sentences, rules);
    expect(short && short.endMs - short.startMs).toBeGreaterThanOrEqual(15_000);
    expect(short?.transcript.split('.').length).toBeGreaterThan(2);
    const [long] = selectReelCandidates([proposal(0, 19)], sentences, rules);
    expect(long && long.endMs - long.startMs).toBeLessThanOrEqual(40_000);
  });

  it('drops invalid proposals and overlapping moments, best first', () => {
    const selected = selectReelCandidates(
      [
        proposal(-1, 3),
        proposal(5, 2),
        proposal(0, 99),
        proposal(2, 5, 6),
        proposal(3, 6, 9), // overlaps the one above and scores higher
        proposal(12, 15, 7),
      ],
      sentences,
      rules,
    );
    expect(selected.map((candidate) => candidate.title)).toEqual([
      'Moment 3',
      'Moment 12',
    ]);
    expect(selected.map((candidate) => candidate.rank)).toEqual([1, 2]);
  });

  it('caps the number of candidates', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      proposal(i * 3, i * 3 + 2),
    );
    expect(
      selectReelCandidates(many, sentences, { ...rules, maxCandidates: 3 }),
    ).toHaveLength(3);
  });

  it('weights scores into [0, 1] and clamps out-of-range model scores', () => {
    const scores = {
      standalone: 10,
      impact: 10,
      quotability: 10,
      contextIndependence: 10,
    };
    expect(weightedScore(scores)).toBe(1);
    expect(weightedScore({ ...scores, impact: 99 })).toBe(1);
    expect(
      weightedScore({
        standalone: 1,
        impact: 1,
        quotability: 1,
        contextIndependence: 1,
      }),
    ).toBe(0);
  });
});

describe('planCropPath', () => {
  const landscape = {
    sourceWidth: 1920,
    sourceHeight: 1080,
    durationMs: 30_000,
  };

  it('does not crop sources that are already vertical', () => {
    expect(
      planCropPath({
        samples: [],
        sourceWidth: 1080,
        sourceHeight: 1920,
        durationMs: 10_000,
      }),
    ).toBeNull();
  });

  it('holds a steady centre frame without usable samples', () => {
    const plan = planCropPath({
      ...landscape,
      samples: [{ tMs: 0, cx: 0.1, confidence: 0.2 }],
    });
    expect(plan).toEqual({
      cropWidth: 606,
      cropHeight: 1080,
      keyframes: [{ tMs: 0, x: 657 }],
    });
  });

  it('frames the speaker and ignores small movement inside the dead zone', () => {
    const samples = Array.from({ length: 31 }, (_, i) => ({
      tMs: i * 1_000,
      cx: 0.75 + (i % 2 ? 0.01 : -0.01), // gesturing on the spot
      confidence: 0.9,
    }));
    const plan = planCropPath({ ...landscape, samples });
    // One steady frame around the speaker (median of the first samples: cx 0.74 → x 1118).
    expect(plan?.keyframes).toEqual([{ tMs: 0, x: 1118 }]);
  });

  it('pans smoothly, never faster than the speed limit, and stays inside the frame', () => {
    const samples = [
      { tMs: 0, cx: 0.2, confidence: 0.9 },
      { tMs: 1_000, cx: 0.2, confidence: 0.9 },
      { tMs: 2_000, cx: 0.95, confidence: 0.9 },
      ...Array.from({ length: 28 }, (_, i) => ({
        tMs: 3_000 + i * 1_000,
        cx: 0.95,
        confidence: 0.9,
      })),
    ];
    const plan = planCropPath({ ...landscape, samples });
    const frames = plan?.keyframes ?? [];
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.length).toBeLessThanOrEqual(MAX_KEYFRAMES);
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1] as { tMs: number; x: number };
      const b = frames[i] as { tMs: number; x: number };
      const pxPerSecond = Math.abs(b.x - a.x) / ((b.tMs - a.tMs) / 1000);
      expect(pxPerSecond).toBeLessThanOrEqual(606 * 0.35 + 1);
    }
    expect(frames.at(-1)?.x).toBe(1920 - 606); // clamped at the right edge
    expect(frames.every((frame) => frame.x >= 0)).toBe(true);
  });

  it('ignores a single outlier sample (median filter)', () => {
    const samples = Array.from({ length: 21 }, (_, i) => ({
      tMs: i * 500,
      cx: i === 10 ? 0.05 : 0.5,
      confidence: 0.9,
    }));
    const plan = planCropPath({ ...landscape, durationMs: 10_000, samples });
    expect(plan?.keyframes).toHaveLength(1);
  });
});

const reel = (overrides: Partial<Reel> = {}): Reel => ({
  id: 'r1',
  churchId: 'c1',
  sermonId: 's1',
  candidateId: null,
  title: 'Moment',
  startMs: 0,
  endMs: 30_000,
  transcript: 'Walk by faith.',
  hook: null,
  hookOptions: [],
  captionStyle: 'WORD_HIGHLIGHT',
  captionPosition: 'bottom',
  status: 'DRAFT',
  progress: 0,
  renderAttempt: 0,
  editedSinceRender: false,
  outputAssetId: null,
  thumbnailAssetId: null,
  durationMs: null,
  sizeBytes: null,
  errorMessage: null,
  approvedAt: null,
  renderRequestedAt: null,
  renderedAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

describe('reel lifecycle', () => {
  const now = new Date('2026-10-05T10:00:00Z');
  const rendered = reel({
    status: 'COMPLETED',
    renderAttempt: 1,
    renderedAt: now,
    approvedAt: now,
    outputAssetId: 'a1',
  });

  it('validates windows against the configured limits and the sermon length', () => {
    const rules = { minMs: 15_000, maxMs: 90_000 };
    expect(() =>
      validateWindow({ startMs: 0, endMs: 10_000 }, rules, null),
    ).toThrow();
    expect(() =>
      validateWindow({ startMs: 0, endMs: 100_000 }, rules, null),
    ).toThrow();
    expect(() =>
      validateWindow({ startMs: 0, endMs: 30_000 }, rules, 20_000),
    ).toThrow();
    expect(() =>
      validateWindow({ startMs: 5, endMs: 30_000 }, rules, 60_000),
    ).not.toThrow();
  });

  it('never presents a hook as a quote', () => {
    expect(normalizeHookText('  “Faith   over fear”  ')).toBe(
      'Faith over fear',
    );
    expect(validateHook({ text: '"Trust Him"', style: 'IMPACT' })).toEqual({
      text: 'Trust Him',
      style: 'IMPACT',
    });
    expect(() =>
      validateHook({ text: 'x'.repeat(91), style: 'IMPACT' }),
    ).toThrow();
    expect(() => validateHook({ text: 'Hi', style: 'SPARKLE' })).toThrow();
  });

  it('marks a rendered Reel out of date and unapproved when its look changes', () => {
    const edited = applyReelEdit(rendered, { captionStyle: 'POP' }, now);
    expect(edited).toMatchObject({ editedSinceRender: true, approvedAt: null });
    expect(needsRender(edited)).toBe(true);
    // A title change does not touch the video.
    expect(applyReelEdit(rendered, { title: 'New title' }, now)).toMatchObject({
      editedSinceRender: false,
      approvedAt: now,
    });
  });

  it('refuses edits while rendering', () => {
    expect(() =>
      applyReelEdit(reel({ status: 'ENCODING' }), { title: 'x' }, now),
    ).toThrow(expect.objectContaining({ code: 'REEL_RENDERING' }));
  });

  it('renders only when needed and counts attempts', () => {
    expect(needsRender(reel())).toBe(true);
    expect(needsRender(rendered)).toBe(false);
    expect(needsRender(reel({ status: 'QUEUED' }))).toBe(false);
    const queued = queueRender(
      reel({ status: 'FAILED', errorMessage: 'x' }),
      now,
    );
    expect(queued).toMatchObject({
      status: 'QUEUED',
      renderAttempt: 1,
      errorMessage: null,
      renderRequestedAt: now,
    });
  });

  it('approves only the latest completed render, idempotently', () => {
    expect(() => approveReel(reel(), now)).toThrow();
    expect(() =>
      approveReel({ ...rendered, editedSinceRender: true }, now),
    ).toThrow();
    const approved = approveReel({ ...rendered, approvedAt: null }, now);
    expect(approved.approvedAt).toEqual(now);
    expect(approveReel(approved, new Date())).toBe(approved);
  });
});
