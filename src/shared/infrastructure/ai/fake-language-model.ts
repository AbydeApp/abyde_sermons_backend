import { createHash } from 'node:crypto';
import {
  type EmbeddingRequest,
  type EmbeddingResult,
  EMBEDDING_DIMENSIONS,
  InvalidModelOutputError,
  type LanguageModelPort,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
} from '../../application/ports/language-model.port.js';

interface FakeSegment {
  sequence: number;
  text: string;
}

const segmentsOf = (input: Record<string, unknown>): FakeSegment[] => {
  const raw = (input.segments ??
    (input.sermon as { segments?: unknown } | undefined)?.segments) as
    FakeSegment[] | undefined;
  return Array.isArray(raw) ? raw : [];
};

const str = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback;

const firstSentence = (text: string) =>
  (text.match(/[^.!?]+[.!?]/)?.[0] ?? text).trim();

/**
 * Deterministic stand-in for a real model (local development and tests). Outputs are derived from
 * the request's structured input so they stay grounded in the actual transcript, and every result is
 * still validated against the caller's schema — exactly like a real provider response.
 */
export class FakeLanguageModel implements LanguageModelPort {
  /** Schema names (or `embedding`) that should fail; lets tests exercise failure paths. */
  readonly failures = new Set<string>();

  async generateStructured<T>(
    request: StructuredGenerationRequest<T>,
  ): Promise<StructuredGenerationResult<T>> {
    if (this.failures.has(request.schemaName))
      throw new InvalidModelOutputError(request.schemaName, 'forced failure');
    const candidate = this.build(request.schemaName, request.input);
    const parsed = request.schema.safeParse(candidate);
    if (!parsed.success)
      throw new InvalidModelOutputError(
        request.schemaName,
        parsed.error.message,
      );
    return { data: parsed.data, provider: 'fake', model: 'fake-1' };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    if (this.failures.has('embedding'))
      throw new Error('forced embedding failure');
    return {
      vectors: request.inputs.map(embedText),
      provider: 'fake',
      model: 'fake-embedding-1',
    };
  }

  private build(schemaName: string, input: Record<string, unknown>): unknown {
    const segments = segmentsOf(input);
    const at = (index: number) =>
      segments[Math.min(index, Math.max(0, segments.length - 1))];
    switch (schemaName) {
      case 'sermon_analysis': {
        const first = at(0);
        const quoteSource =
          segments.find((segment) => /faith|trust|god/i.test(segment.text)) ??
          first;
        return {
          title: str(input.title, 'Sermon'),
          summary:
            segments
              .slice(0, 3)
              .map((segment) => firstSentence(segment.text))
              .join(' ') || 'A sermon.',
          mainTheme: {
            text: 'Walking by faith',
            segment: first?.sequence ?? null,
          },
          secondaryThemes: [
            { text: 'Trusting God', segment: at(1)?.sequence ?? null },
          ],
          keyPoints: segments.slice(0, 3).map((segment) => ({
            text: firstSentence(segment.text),
            segment: segment.sequence,
          })),
          quotes: quoteSource
            ? [
                {
                  text: firstSentence(quoteSource.text),
                  segment: quoteSource.sequence,
                },
              ]
            : [],
          stories: [],
          applications: [
            {
              text: 'Take one step of obedience this week.',
              segment: at(2)?.sequence ?? null,
            },
          ],
          prayers: [
            { text: 'Lord, give us courage to walk by faith.', segment: null },
          ],
          questions: [
            {
              text: 'Where is God asking you to trust Him this week?',
              segment: null,
            },
          ],
          audienceTakeaways: [
            { text: 'Faith grows one step at a time.', segment: null },
          ],
          scriptures: [
            { reference: 'Hebrews 11:1', segment: first?.sequence ?? null },
          ],
        };
      }
      case 'content_batch': {
        const count = Number(input.count ?? 1);
        const type = str(input.type, 'CONTENT');
        return {
          items: Array.from({ length: count }, (_, index) => {
            const segment = at(index);
            return {
              title: `${type === 'DEVOTIONAL' ? `Day ${index + 1}: ` : ''}${segment ? firstSentence(segment.text).slice(0, 60) : 'Reflection'}`,
              body: `Reflecting on Sunday's message. ${segment ? firstSentence(segment.text) : ''} Take a moment this week to trust God with the next step.`,
              scripture: index === 0 ? 'Hebrews 11:1' : null,
              segments: segment ? [segment.sequence] : [],
            };
          }),
        };
      }
      case 'quote_batch':
        return {
          items: segments.slice(0, 6).map((segment) => ({
            title: 'From the sermon',
            quote: firstSentence(segment.text),
            segment: segment.sequence,
          })),
        };
      case 'content_rewrite': {
        const body = str(input.body, '');
        const action = str(input.action, 'ALTERNATIVE');
        return {
          title: str(input.title, 'Untitled'),
          body:
            action === 'SHORTEN'
              ? body.slice(0, Math.max(20, Math.floor(body.length / 2)))
              : `${body} (${action.toLowerCase()})`,
          scripture: (input.scripture as string | null) ?? null,
        };
      }
      case 'grounded_answer': {
        const excerpts = (input.excerpts as string[] | undefined) ?? [];
        return excerpts.length > 0
          ? {
              sufficientEvidence: true,
              answer: `Your sermons address this: ${firstSentence(excerpts[0] ?? '')}`,
              citedExcerpts: [1],
            }
          : {
              sufficientEvidence: false,
              answer: 'The archive does not cover this question.',
              citedExcerpts: [],
            };
      }
      default:
        throw new InvalidModelOutputError(
          schemaName,
          'no fake builder registered',
        );
    }
  }
}

/** Hashed bag-of-words embedding: texts sharing words have higher cosine similarity. */
export function embedText(text: string): number[] {
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  const words = text.toLowerCase().match(/[a-z0-9']{3,}/g) ?? [];
  for (const word of words) {
    const hash = createHash('md5').update(word).digest();
    const index = hash.readUInt32BE(0) % EMBEDDING_DIMENSIONS;
    vector[index] =
      (vector[index] ?? 0) +
      (hash[4] !== undefined && hash[4] % 2 === 0 ? 1 : 0.8);
  }
  const norm =
    Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}
