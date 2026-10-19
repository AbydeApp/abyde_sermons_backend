import type {
  LanguageModelPort,
  StructuredGenerationRequest,
} from '../../../shared/application/ports/language-model.port.js';
import { ContentGenerationService } from './content-generator.js';
import type { SermonContext } from './sermon-context.adapter.js';

const sermon: SermonContext = {
  churchId: 'c1',
  sermonId: 's1',
  title: 'Faith',
  speaker: 'Pastor Ade',
  sermonDate: new Date('2026-09-27T09:00:00Z'),
  status: 'READY',
  intelligence: null,
  segments: [
    {
      id: 'seg-1',
      sequence: 1,
      startTimeMs: 0,
      endTimeMs: 60_000,
      text: 'We walk by faith, not by sight.',
      speakerLabel: null,
    },
    {
      id: 'seg-2',
      sequence: 2,
      startTimeMs: 60_000,
      endTimeMs: 120_000,
      text: 'Trust is built one step at a time.',
      speakerLabel: null,
    },
  ],
  scriptureReferences: [
    {
      id: 'ref-1',
      churchId: 'c1',
      sermonId: 's1',
      book: '2 Corinthians',
      chapter: 5,
      verseStart: 7,
      verseEnd: null,
      translation: 'NIV',
      verified: true,
      display: '2 Corinthians 5:7',
      sourceSegmentId: 'seg-1',
    },
  ],
};

const modelReturning = (
  data: unknown,
): LanguageModelPort & {
  requests: Array<StructuredGenerationRequest<unknown>>;
} => {
  const requests: Array<StructuredGenerationRequest<unknown>> = [];
  return {
    requests,
    generateStructured: async <T>(request: StructuredGenerationRequest<T>) => {
      requests.push(request as StructuredGenerationRequest<unknown>);
      return { data: request.schema.parse(data), provider: 'test', model: 'm' };
    },
    embed: async () => ({ vectors: [], provider: 'test', model: 'e' }),
  };
};

describe('ContentGenerationService (AI guardrails)', () => {
  it('keeps only canon-valid scripture and links evidence to sermon segments', async () => {
    const model = modelReturning({
      items: [
        {
          title: 'Day 1',
          body: 'Walk by faith.',
          scripture: '2 Cor 5:7',
          segments: [1, 2, 42],
        },
        {
          title: 'Day 2',
          body: 'Trust.',
          scripture: 'Opinions 3:16',
          segments: [],
        },
      ],
    });
    const output = await new ContentGenerationService(model).generate(
      'DEVOTIONAL',
      sermon,
      null,
      2,
    );
    expect(output.pieces[0]).toMatchObject({
      scripture: '2 Corinthians 5:7',
      sourceMetadata: {
        transcriptSegmentIds: ['seg-1', 'seg-2'],
        scriptureReferenceIds: ['ref-1'],
        startTimeMs: 0,
        endTimeMs: 120_000,
        verbatim: false,
      },
    });
    expect(output.pieces[1]?.scripture).toBeNull();
    expect(model.requests[0]?.system).toMatch(
      /Never invent or alter Bible verses/,
    );
  });

  it('marks extracted quotes verbatim and drops paraphrases', async () => {
    const model = modelReturning({
      items: [
        {
          title: 'Faith',
          quote: 'We walk by faith, not by sight.',
          segment: 1,
        },
        {
          title: 'Made up',
          quote: 'Faith is a feeling you cannot explain.',
          segment: 2,
        },
      ],
    });
    const output = await new ContentGenerationService(model).generate(
      'QUOTE',
      sermon,
      null,
    );
    expect(output.pieces).toHaveLength(1);
    expect(output.pieces[0]).toMatchObject({
      body: 'We walk by faith, not by sight.',
      sourceMetadata: { verbatim: true, transcriptSegmentIds: ['seg-1'] },
    });
  });

  it('carries church preferences and words to avoid into the prompt', async () => {
    const model = modelReturning({
      items: [{ title: 'Post', body: 'Body', scripture: null, segments: [] }],
    });
    await new ContentGenerationService(model).generate(
      'SOCIAL_POST',
      sermon,
      {
        churchId: 'c1',
        name: 'Grace Church',
        preferredBibleTranslation: 'KJV',
        devotionalTone: null,
        socialTone: 'Encouraging and concise',
        audienceDescription: 'Young professionals in Lagos',
        wordsToAvoid: 'hustle',
        additionalAIContext: '',
      },
      1,
    );
    expect(model.requests[0]?.system).toEqual(
      expect.stringContaining('Never use these words or phrases: hustle'),
    );
    expect(model.requests[0]?.system).toEqual(
      expect.stringContaining('Tone: Encouraging and concise'),
    );
    expect(model.requests[0]?.system).toEqual(expect.stringContaining('KJV'));
  });
});
