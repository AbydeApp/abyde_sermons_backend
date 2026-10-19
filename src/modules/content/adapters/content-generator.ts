import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { ChurchAIProfile } from '../../../shared/application/church-profile.js';
import {
  LANGUAGE_MODEL,
  type LanguageModelPort,
} from '../../../shared/application/ports/language-model.port.js';
import {
  formatReference,
  parseReference,
  verifyReference,
} from '../../../shared/domain/scripture/scripture.js';
import {
  isVerbatimExcerpt,
  normalizeForComparison,
} from '../../../shared/domain/text.js';
import {
  buildTranscriptContext,
  GUARDRAILS,
} from '../../sermons/helper.js';
import type { TranscriptSegmentRecord } from '../../sermons/helper.js';
import {
  type AIAttribution,
  CONTENT_SPECS,
  type ContentType,
  REWRITE_INSTRUCTIONS,
  type RewriteAction,
  type SourceMetadata,
} from '../helper.js';
import type { SermonContext } from './sermon-context.adapter.js';

const MAX_CONTEXT_CHARS = 60_000;

const GeneratedPieceSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
  scripture: z.string().max(80).nullable(),
  segments: z.array(z.number().int()).max(8),
});
const GeneratedBatchSchema = z.object({
  items: z.array(GeneratedPieceSchema).min(1).max(10),
});
const QuoteBatchSchema = z.object({
  items: z
    .array(
      z.object({
        title: z.string().min(1).max(80),
        quote: z.string().min(1).max(500),
        segment: z.number().int(),
      }),
    )
    .max(10),
});
const RewriteSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
  scripture: z.string().max(80).nullable(),
});

export interface GeneratedPiece {
  position: number;
  title: string;
  body: string;
  scripture: string | null;
  sourceMetadata: SourceMetadata;
}

export interface GenerationOutput {
  pieces: GeneratedPiece[];
  ai: AIAttribution;
}

/** Application workflow for producing ministry content from one sermon. Each content type is a separate call. */
@Injectable()
export class ContentGenerationService {
  constructor(
    @Inject(LANGUAGE_MODEL) private readonly model: LanguageModelPort,
  ) {}

  async generate(
    type: ContentType,
    sermon: SermonContext,
    profile: ChurchAIProfile | null,
    count?: number,
    /** Bodies that must not be produced again (used when regenerating a quote). */
    exclude: string[] = [],
    /** Aborts the model call (job time limit, shutdown). */
    signal?: AbortSignal,
  ): Promise<GenerationOutput> {
    if (type === 'QUOTE')
      return this.generateQuotes(sermon, profile, count, exclude, signal);
    const spec = CONTENT_SPECS[type];
    const wanted = count ?? spec.count;
    const result = await this.model.generateStructured({
      context: {
        operation: `content.generate.${type.toLowerCase()}`,
        churchId: sermon.churchId,
        sermonId: sermon.sermonId,
      },
      schemaName: 'content_batch',
      signal,
      schema: GeneratedBatchSchema,
      temperature: 0.7,
      system: systemPrompt(profile, spec.tone),
      prompt: [
        `Task: write ${wanted} ${spec.label}.`,
        spec.instructions,
        wanted !== spec.count
          ? `Only ${wanted} new item(s) are needed now; ignore the count above.`
          : '',
        `Return exactly ${wanted} item(s). For each, list the transcript segment numbers it draws on in "segments", and put at most one Bible reference the preacher used in "scripture" (or null).`,
        '',
        sermonBrief(sermon),
      ].join('\n'),
      input: {
        type,
        count: wanted,
        sermon: { title: sermon.title, segments: sermon.segments },
      },
    });
    const pieces = result.data.items.slice(0, wanted).map((item, index) => ({
      position: index + 1,
      title: item.title.trim(),
      body: item.body.trim().slice(0, spec.maxBodyChars),
      scripture: verifiedScripture(item.scripture),
      sourceMetadata: sourceFor(sermon, item.segments, item.scripture, false),
    }));
    return { pieces, ai: { provider: result.provider, model: result.model } };
  }

  async rewrite(
    input: {
      type: ContentType;
      title: string;
      body: string;
      scripture: string | null;
      action: RewriteAction;
      churchId: string;
      sermonId: string;
    },
    profile: ChurchAIProfile | null,
  ): Promise<{
    title: string;
    body: string;
    scripture: string | null;
    ai: AIAttribution;
  }> {
    const spec = CONTENT_SPECS[input.type];
    const result = await this.model.generateStructured({
      context: {
        operation: 'content.rewrite',
        churchId: input.churchId,
        sermonId: input.sermonId,
      },
      schemaName: 'content_rewrite',
      schema: RewriteSchema,
      temperature: 0.7,
      system: systemPrompt(profile, spec.tone),
      prompt: [
        `Rewrite this ${spec.label.replace(/s$/, '')}. ${REWRITE_INSTRUCTIONS[input.action]}`,
        'Keep any Bible reference unchanged unless removing it; never add a new one.',
        '',
        `Title: ${input.title}`,
        input.scripture ? `Scripture: ${input.scripture}` : '',
        'Body:',
        input.body,
      ].join('\n'),
      input: {
        action: input.action,
        title: input.title,
        body: input.body,
        scripture: input.scripture,
      },
    });
    return {
      title: result.data.title.trim(),
      body: result.data.body.trim().slice(0, spec.maxBodyChars),
      scripture: result.data.scripture
        ? (verifiedScripture(result.data.scripture) ?? input.scripture)
        : null,
      ai: { provider: result.provider, model: result.model },
    };
  }

  /**
   * Quotes are extracted, not written: start from intelligence quotes (already verified),
   * top up with model-selected lines, and keep only exact transcript matches.
   */
  private async generateQuotes(
    sermon: SermonContext,
    profile: ChurchAIProfile | null,
    count: number | undefined,
    exclude: string[],
    signal?: AbortSignal,
  ): Promise<GenerationOutput> {
    const wanted = count ?? CONTENT_SPECS.QUOTE.count;
    const excluded = new Set(exclude.map(normalizeForComparison));
    const bySequence = new Map(
      sermon.segments.map((segment) => [segment.sequence, segment]),
    );
    const byId = new Map(
      sermon.segments.map((segment) => [segment.id, segment]),
    );
    const candidates: Array<{
      title: string;
      quote: string;
      segment: TranscriptSegmentRecord;
    }> = [];
    for (const quote of sermon.intelligence?.quotes ?? []) {
      const segment = quote.sourceSegmentId
        ? byId.get(quote.sourceSegmentId)
        : undefined;
      if (segment && !excluded.has(normalizeForComparison(quote.text)))
        candidates.push({
          title: labelFor(quote.text),
          quote: quote.text,
          segment,
        });
    }
    let ai: AIAttribution = { provider: 'extraction', model: 'transcript' };
    if (candidates.length < wanted) {
      const result = await this.model.generateStructured({
        context: {
          operation: 'content.generate.quote',
          churchId: sermon.churchId,
          sermonId: sermon.sermonId,
        },
        schemaName: 'quote_batch',
        signal,
        schema: QuoteBatchSchema,
        temperature: 0.2,
        system: systemPrompt(profile, 'social'),
        prompt: [
          CONTENT_SPECS.QUOTE.instructions,
          '',
          sermonBrief(sermon),
        ].join('\n'),
        input: { segments: sermon.segments },
      });
      ai = { provider: result.provider, model: result.model };
      for (const item of result.data.items) {
        const segment = bySequence.get(item.segment);
        if (segment)
          candidates.push({ title: item.title, quote: item.quote, segment });
      }
    }
    const seen = new Set<string>(excluded);
    const pieces = candidates
      .filter((candidate) => {
        const next = bySequence.get(candidate.segment.sequence + 1)?.text ?? '';
        const key = normalizeForComparison(candidate.quote);
        if (
          seen.has(key) ||
          !isVerbatimExcerpt(
            candidate.quote,
            `${candidate.segment.text} ${next}`,
          )
        )
          return false;
        seen.add(key);
        return true;
      })
      .slice(0, wanted)
      .map((candidate, index) => ({
        position: index + 1,
        title: candidate.title.trim(),
        body: candidate.quote.trim(),
        scripture: null,
        sourceMetadata: sourceFor(
          sermon,
          [candidate.segment.sequence],
          null,
          true,
        ),
      }));
    return { pieces, ai };
  }
}

function systemPrompt(
  profile: ChurchAIProfile | null,
  tone: 'devotional' | 'social',
): string {
  const lines = [
    `You write ministry content for ${profile?.name ?? 'a local church'} in Nigeria, based on one of its sermons.`,
    GUARDRAILS,
    '- Do not put words in the pastor\'s mouth: no "Pastor said..." with invented wording, no quotation marks around your own sentences.',
    '- Everything you write is a draft for the church team to review.',
  ];
  if (profile) {
    const toneText =
      tone === 'devotional' ? profile.devotionalTone : profile.socialTone;
    if (toneText) lines.push(`Tone: ${toneText}.`);
    lines.push(
      `Preferred Bible translation: ${profile.preferredBibleTranslation} (cite references only; do not reproduce long verse text).`,
    );
    if (profile.audienceDescription)
      lines.push(`Audience: ${profile.audienceDescription}`);
    if (profile.wordsToAvoid)
      lines.push(`Never use these words or phrases: ${profile.wordsToAvoid}`);
    if (profile.additionalAIContext)
      lines.push(`Church context: ${profile.additionalAIContext}`);
  }
  return lines.join('\n');
}

function sermonBrief(sermon: SermonContext): string {
  const intel = sermon.intelligence;
  const list = (label: string, items: Array<{ text: string }> | undefined) =>
    items && items.length > 0
      ? `${label}:\n${items.map((item) => `- ${item.text}`).join('\n')}`
      : '';
  return [
    `Sermon: "${sermon.title}" by ${sermon.speaker}`,
    intel ? `Summary: ${intel.summary}` : '',
    intel ? `Main theme: ${intel.mainTheme.text}` : '',
    list('Key points', intel?.keyPoints),
    list('Applications', intel?.applications),
    intel && intel.scriptures.length > 0
      ? `Scriptures the preacher used: ${intel.scriptures.join('; ')}`
      : '',
    '',
    'Transcript segments:',
    buildTranscriptContext(sermon.segments, MAX_CONTEXT_CHARS),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** Only canon-valid references survive; anything else becomes null rather than an invented verse. */
function verifiedScripture(raw: string | null): string | null {
  if (!raw) return null;
  const ref = parseReference(raw);
  return ref && verifyReference(ref).valid ? formatReference(ref) : null;
}

function sourceFor(
  sermon: SermonContext,
  sequences: number[],
  scripture: string | null,
  verbatim: boolean,
): SourceMetadata {
  const bySequence = new Map(
    sermon.segments.map((segment) => [segment.sequence, segment]),
  );
  const segments = [...new Set(sequences)].flatMap(
    (sequence) => bySequence.get(sequence) ?? [],
  );
  const display = verifiedScripture(scripture);
  const scriptureIds = display
    ? sermon.scriptureReferences
        .filter((ref) => ref.verified && ref.display === display)
        .map((ref) => ref.id)
    : [];
  return {
    sermonId: sermon.sermonId,
    transcriptSegmentIds: segments.map((segment) => segment.id),
    scriptureReferenceIds: scriptureIds,
    startTimeMs:
      segments.length > 0
        ? Math.min(...segments.map((segment) => segment.startTimeMs))
        : null,
    endTimeMs:
      segments.length > 0
        ? Math.max(...segments.map((segment) => segment.endTimeMs))
        : null,
    verbatim,
  };
}

function labelFor(text: string): string {
  return text
    .split(/\s+/)
    .slice(0, 4)
    .join(' ')
    .replace(/[.,;:!?]+$/, '');
}
