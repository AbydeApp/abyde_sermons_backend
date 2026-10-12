import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import {
  LANGUAGE_MODEL,
  type LanguageModelPort,
} from '../../../shared/application/ports/language-model.port.js';
import { formatTimestamp } from '../../sermons/application/services/prompt-context.js';
import type {
  GroundedAnswer,
  GroundedAnswerPort,
} from '../application/ports/out/segment-search.port.js';

const GroundedAnswerSchema = z.object({
  sufficientEvidence: z.boolean(),
  answer: z.string().min(1).max(4000),
  citedExcerpts: z.array(z.number().int()).max(20),
});

export const ANSWER_FALLBACK =
  "I couldn't write a summary just now, but these passages from your sermons are the closest matches to your question.";

/**
 * Answers from the supplied excerpts only. If the model is unavailable or returns unusable output,
 * the fallback makes no claim of its own: it points the user to the closest passages, which are
 * still shown as sources.
 */
@Injectable()
export class AIGroundedAnswerAdapter implements GroundedAnswerPort {
  private readonly logger = new Logger(AIGroundedAnswerAdapter.name);

  constructor(
    @Inject(LANGUAGE_MODEL) private readonly model: LanguageModelPort,
  ) {}

  async answer(
    input: Parameters<GroundedAnswerPort['answer']>[0],
  ): Promise<GroundedAnswer> {
    try {
      const result = await this.model.generateStructured({
        context: { operation: 'ask.answer', churchId: input.churchId },
        schemaName: 'grounded_answer',
        schema: GroundedAnswerSchema,
        temperature: 0.2,
        system: [
          `You answer questions about what ${input.churchName ?? 'this church'} has taught, using ONLY the numbered sermon excerpts provided.`,
          '- If the excerpts do not clearly address the question, set sufficientEvidence to false and say the archive does not cover it.',
          '- Never present general knowledge or your own theology as something this church taught.',
          '- Do not invent quotes or Bible verses. Cite the excerpt numbers you relied on in citedExcerpts.',
          '- Answer in 1–3 short paragraphs.',
        ].join('\n'),
        prompt: [
          `Question: ${input.question}`,
          '',
          'Sermon excerpts:',
          ...input.excerpts.map(
            (excerpt, index) =>
              `[${index + 1}] "${excerpt.sermonTitle}" (${excerpt.sermonDate.toISOString().slice(0, 10)}, at ${formatTimestamp(excerpt.startTimeMs)}): ${excerpt.text}`,
          ),
        ].join('\n'),
        input: {
          question: input.question,
          excerpts: input.excerpts.map((excerpt) => excerpt.text),
        },
      });
      return result.data;
    } catch (error) {
      this.logger.warn(
        { err: error },
        'Answer generation unavailable; returning closest passages',
      );
      return {
        sufficientEvidence: true,
        answer: ANSWER_FALLBACK,
        citedExcerpts: [1, 2, 3].filter((n) => n <= input.excerpts.length),
      };
    }
  }
}
