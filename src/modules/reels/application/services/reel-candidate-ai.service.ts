import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  LANGUAGE_MODEL,
  type LanguageModelPort,
} from '../../../../shared/application/ports/language-model.port.js';
import type { CandidateProposal } from '../../domain/reel-candidates.js';
import type { Sentence } from '../../domain/transcript-sentences.js';

// Scores are validated (clamped to 1–10) in the domain, not by the schema: providers' strict
// JSON-schema modes differ in which numeric bounds they accept.
export const ReelCandidatesSchema = z.object({
  candidates: z
    .array(
      z.object({
        startSentence: z.number().int(),
        endSentence: z.number().int(),
        title: z.string().min(1).max(120),
        reason: z.string().min(1).max(400),
        standalone: z.number(),
        impact: z.number(),
        quotability: z.number(),
        contextIndependence: z.number(),
      }),
    )
    .max(15),
});

const clock = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** Asks the model which moments of a sermon stand alone as short vertical videos. */
@Injectable()
export class ReelCandidateAIService {
  constructor(
    @Inject(LANGUAGE_MODEL) private readonly model: LanguageModelPort,
  ) {}

  async propose(input: {
    churchId: string;
    sermonId: string;
    title: string;
    speaker: string;
    mainTheme: string | null;
    sentences: Sentence[];
    minSeconds: number;
    maxSeconds: number;
    signal?: AbortSignal;
  }): Promise<CandidateProposal[]> {
    const result = await this.model.generateStructured({
      context: {
        operation: 'reel.candidates',
        churchId: input.churchId,
        sermonId: input.sermonId,
      },
      schemaName: 'reel_candidates',
      schema: ReelCandidatesSchema,
      temperature: 0.3,
      signal: input.signal,
      system: [
        "You help a church's media team find moments in the pastor's real sermon that work as short vertical videos (Reels, Shorts, TikTok).",
        'Pick 5 to 10 moments. A good moment: makes sense to someone who never heard the rest of the sermon, has impact, contains a memorable line, starts at the beginning of a thought and ends when the thought is complete.',
        `Each moment should run about ${input.minSeconds}–${input.maxSeconds} seconds; use the timestamps.`,
        'Refer to sentences only by their [number]. Moments must not overlap.',
        'Score each moment 1–10 for: standalone (understandable alone), impact, quotability, contextIndependence (no "as I said earlier", no unexplained references).',
        'The title is a short internal label for the media team, not a quote.',
        'Never pick a moment for something the pastor did not say.',
      ].join('\n'),
      prompt: [
        `Sermon: ${input.title}`,
        `Speaker: ${input.speaker}`,
        input.mainTheme ? `Main theme: ${input.mainTheme}` : '',
        '',
        'Sentences:',
        ...input.sentences.map(
          (sentence) =>
            `[${sentence.index}] (${clock(sentence.startMs)}) ${sentence.text}`,
        ),
      ]
        .filter((line) => line !== '')
        .join('\n'),
      input: {
        sentences: input.sentences,
        minSeconds: input.minSeconds,
        maxSeconds: input.maxSeconds,
      },
    });
    return result.data.candidates.map((candidate) => ({
      startSentence: candidate.startSentence,
      endSentence: candidate.endSentence,
      title: candidate.title,
      reason: candidate.reason,
      scores: {
        standalone: candidate.standalone,
        impact: candidate.impact,
        quotability: candidate.quotability,
        contextIndependence: candidate.contextIndependence,
      },
    }));
  }
}
