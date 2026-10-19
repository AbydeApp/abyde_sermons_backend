import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { ChurchAIProfile } from '../../../shared/application/church-profile.js';
import {
  LANGUAGE_MODEL,
  type LanguageModelPort,
} from '../../../shared/application/ports/language-model.port.js';
import { newId } from '../../../shared/domain/id.js';
import {
  detectReferences,
  formatReference,
  parseReference,
  verifyReference,
} from '../../../shared/domain/scripture/scripture.js';
import { isVerbatimExcerpt } from '../../../shared/domain/text.js';
import type {
  IntelligenceItem,
  ScriptureReferenceRecord,
  SermonIntelligence,
  TranscriptSegmentRecord,
} from '../helper.js';
import { buildTranscriptContext, GUARDRAILS } from '../helper.js';

const AnalysisItem = z.object({
  text: z.string().min(1).max(600),
  segment: z.number().int().nullable(),
});
const ThemeItem = z.object({
  text: z.string().min(1).max(100),
  segment: z.number().int().nullable(),
});

export const SermonAnalysisSchema = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(2000),
  mainTheme: ThemeItem,
  secondaryThemes: z.array(ThemeItem).max(6),
  keyPoints: z.array(AnalysisItem).max(10),
  quotes: z
    .array(
      z.object({ text: z.string().min(1).max(500), segment: z.number().int() }),
    )
    .max(12),
  stories: z.array(AnalysisItem).max(8),
  applications: z.array(AnalysisItem).max(8),
  prayers: z.array(AnalysisItem).max(6),
  questions: z.array(AnalysisItem).max(8),
  audienceTakeaways: z.array(AnalysisItem).max(8),
  scriptures: z
    .array(
      z.object({
        reference: z.string().min(1).max(80),
        segment: z.number().int().nullable(),
      }),
    )
    .max(40),
});

export type SermonAnalysis = z.infer<typeof SermonAnalysisSchema>;

export interface AnalysisResult {
  intelligence: SermonIntelligence;
  scriptureReferences: ScriptureReferenceRecord[];
  provider: string;
  model: string;
}

/** Application workflow: turns a segmented transcript into validated, evidence-linked sermon intelligence. */
@Injectable()
export class SermonAnalysisService {
  constructor(
    @Inject(LANGUAGE_MODEL) private readonly model: LanguageModelPort,
  ) {}

  async analyze(input: {
    churchId: string;
    sermonId: string;
    title: string;
    speaker: string;
    mainScripture: string | null;
    segments: TranscriptSegmentRecord[];
    profile: ChurchAIProfile | null;
    signal?: AbortSignal;
  }): Promise<AnalysisResult> {
    const transcript = buildTranscriptContext(input.segments);
    const result = await this.model.generateStructured({
      context: {
        operation: 'sermon.analyze',
        churchId: input.churchId,
        sermonId: input.sermonId,
      },
      schemaName: 'sermon_analysis',
      signal: input.signal,
      schema: SermonAnalysisSchema,
      temperature: 0.2,
      system: [
        "You analyse church sermons and extract a faithful structured summary for the church's ministry team.",
        GUARDRAILS,
        'Reference transcript segments by their [number]. "quotes" must be copied word-for-word from the numbered segment — never paraphrase a quote.',
        '"scriptures" lists only Bible references the preacher actually cites in the transcript.',
      ].join('\n'),
      prompt: [
        `Sermon title: ${input.title}`,
        `Speaker: ${input.speaker}`,
        input.mainScripture
          ? `Main scripture (provided by the church): ${input.mainScripture}`
          : '',
        input.profile
          ? `Church: ${input.profile.name}. Audience: ${input.profile.audienceDescription || 'general congregation'}.`
          : '',
        '',
        'Transcript segments:',
        transcript,
      ]
        .filter((line) => line !== '')
        .join('\n'),
      input: {
        segments: input.segments,
        title: input.title,
        mainScripture: input.mainScripture,
      },
    });
    return {
      ...assembleIntelligence(result.data, input),
      provider: result.provider,
      model: result.model,
    };
  }
}

/** Maps model output onto real segments, discarding evidence that does not check out. */
export function assembleIntelligence(
  analysis: SermonAnalysis,
  input: {
    churchId: string;
    sermonId: string;
    mainScripture: string | null;
    segments: TranscriptSegmentRecord[];
    profile: ChurchAIProfile | null;
  },
): {
  intelligence: SermonIntelligence;
  scriptureReferences: ScriptureReferenceRecord[];
} {
  const bySequence = new Map(
    input.segments.map((segment) => [segment.sequence, segment]),
  );
  const item = (text: string, sequence: number | null): IntelligenceItem => {
    const segment = sequence === null ? undefined : bySequence.get(sequence);
    return {
      id: newId(),
      text: text.trim(),
      sourceSegmentId: segment?.id ?? null,
      startTimeMs: segment?.startTimeMs ?? null,
      endTimeMs: segment?.endTimeMs ?? null,
    };
  };
  const items = (list: Array<{ text: string; segment: number | null }>) =>
    list.map((entry) => item(entry.text, entry.segment));

  // Guardrail: a quote survives only if it appears verbatim in its segment (or straddles into the next one).
  const quotes = analysis.quotes
    .filter((quote) => {
      const segment = bySequence.get(quote.segment);
      if (!segment) return false;
      const window = [
        segment.text,
        bySequence.get(quote.segment + 1)?.text ?? '',
      ].join(' ');
      return isVerbatimExcerpt(quote.text, window);
    })
    .map((quote) => item(quote.text, quote.segment));

  const scriptureReferences = collectScriptures(analysis, input);
  return {
    intelligence: {
      title: analysis.title.trim(),
      summary: analysis.summary.trim(),
      mainTheme: item(analysis.mainTheme.text, analysis.mainTheme.segment),
      secondaryThemes: items(analysis.secondaryThemes),
      keyPoints: items(analysis.keyPoints),
      quotes,
      stories: items(analysis.stories),
      applications: items(analysis.applications),
      prayers: items(analysis.prayers),
      questions: items(analysis.questions),
      audienceTakeaways: items(analysis.audienceTakeaways),
      scriptures: scriptureReferences
        .filter((ref) => ref.verified)
        .map((ref) => ref.display),
    },
    scriptureReferences,
  };
}

/** Combines deterministic detection with model-proposed references; validity comes from the canon table only. */
function collectScriptures(
  analysis: SermonAnalysis,
  input: {
    churchId: string;
    sermonId: string;
    mainScripture: string | null;
    segments: TranscriptSegmentRecord[];
    profile: ChurchAIProfile | null;
  },
): ScriptureReferenceRecord[] {
  const bySequence = new Map(
    input.segments.map((segment) => [segment.sequence, segment]),
  );
  const records = new Map<string, ScriptureReferenceRecord>();
  const translation = input.profile?.preferredBibleTranslation ?? null;
  const add = (raw: string, segmentId: string | null) => {
    const ref = parseReference(raw);
    const verified = ref !== null && verifyReference(ref).valid;
    const display =
      ref && verified ? formatReference(ref) : raw.trim().slice(0, 80);
    const existing = records.get(display);
    if (existing) {
      existing.sourceSegmentId ??= segmentId;
      return;
    }
    records.set(display, {
      id: newId(),
      churchId: input.churchId,
      sermonId: input.sermonId,
      book: ref?.book ?? raw.trim().slice(0, 40),
      chapter: ref?.chapter ?? 0,
      verseStart: ref?.verseStart ?? null,
      verseEnd: ref?.verseEnd ?? null,
      translation,
      verified,
      display,
      sourceSegmentId: segmentId,
    });
  };
  if (input.mainScripture) add(input.mainScripture, null);
  for (const segment of input.segments) {
    for (const detected of detectReferences(segment.text))
      add(formatReference(detected.ref), segment.id);
  }
  for (const proposed of analysis.scriptures) {
    add(
      proposed.reference,
      proposed.segment === null
        ? null
        : (bySequence.get(proposed.segment)?.id ?? null),
    );
  }
  return [...records.values()];
}
