import type { TranscriptSegmentRecord } from '../../domain/sermon-intelligence.js';
import {
  assembleIntelligence,
  type SermonAnalysis,
} from './sermon-analysis.service.js';
import { buildTranscriptContext } from './prompt-context.js';

const segments: TranscriptSegmentRecord[] = [
  {
    id: 'seg-1',
    sequence: 1,
    startTimeMs: 0,
    endTimeMs: 60_000,
    text: 'Turn to Hebrews 11:1. Faith is confidence in what we hope for.',
    speakerLabel: null,
  },
  {
    id: 'seg-2',
    sequence: 2,
    startTimeMs: 60_000,
    endTimeMs: 120_000,
    text: 'God gave us enough light for the next step.',
    speakerLabel: null,
  },
];

const analysis = (overrides: Partial<SermonAnalysis> = {}): SermonAnalysis => ({
  title: 'Faith',
  summary: 'A sermon on faith.',
  mainTheme: { text: 'Faith', segment: 1 },
  secondaryThemes: [{ text: 'Hope', segment: 99 }],
  keyPoints: [],
  quotes: [],
  stories: [],
  applications: [],
  prayers: [],
  questions: [],
  audienceTakeaways: [],
  scriptures: [],
  ...overrides,
});

const input = {
  churchId: 'c1',
  sermonId: 's1',
  mainScripture: '2 Corinthians 5:7',
  segments,
  profile: null,
};

describe('assembleIntelligence (AI guardrails)', () => {
  it('links evidence to real segments and drops references to segments that do not exist', () => {
    const { intelligence } = assembleIntelligence(analysis(), input);
    expect(intelligence.mainTheme).toMatchObject({
      text: 'Faith',
      sourceSegmentId: 'seg-1',
      startTimeMs: 0,
      endTimeMs: 60_000,
    });
    expect(intelligence.secondaryThemes[0]).toMatchObject({
      text: 'Hope',
      sourceSegmentId: null,
      startTimeMs: null,
    });
  });

  it('keeps only quotes the preacher actually said', () => {
    const { intelligence } = assembleIntelligence(
      analysis({
        quotes: [
          { text: 'God gave us enough light for the next step', segment: 2 },
          { text: 'God always gives us a full map of our lives', segment: 2 },
          { text: 'Faith is confidence in what we hope for', segment: 7 },
        ],
      }),
      input,
    );
    expect(intelligence.quotes.map((quote) => quote.text)).toEqual([
      'God gave us enough light for the next step',
    ]);
  });

  it('verifies scripture against the canon; invented verses are stored unverified and never displayed', () => {
    const { intelligence, scriptureReferences } = assembleIntelligence(
      analysis({
        scriptures: [
          { reference: 'Hebrews 11:1', segment: 1 },
          { reference: 'Hezekiah 4:12', segment: null },
          { reference: 'John 22:1', segment: null },
        ],
      }),
      input,
    );
    expect(intelligence.scriptures).toEqual([
      '2 Corinthians 5:7',
      'Hebrews 11:1',
    ]);
    expect(
      scriptureReferences.find((ref) => ref.display === 'Hebrews 11:1'),
    ).toMatchObject({ verified: true, sourceSegmentId: 'seg-1' });
    expect(
      scriptureReferences
        .filter((ref) => !ref.verified)
        .map((ref) => ref.display),
    ).toEqual(['Hezekiah 4:12', 'John 22:1']);
  });

  it('samples very long transcripts instead of exceeding the context budget', () => {
    const many = Array.from(
      { length: 2000 },
      (_, i) =>
        ({
          ...segments[0],
          id: `s${i}`,
          sequence: i + 1,
        }) as TranscriptSegmentRecord,
    );
    const context = buildTranscriptContext(many, 10_000);
    expect(context.length).toBeLessThanOrEqual(11_000);
    expect(context.startsWith('[1]')).toBe(true);
  });
});
