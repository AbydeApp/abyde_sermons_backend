import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  LANGUAGE_MODEL,
  type LanguageModelPort,
} from '../../../../shared/application/ports/language-model.port.js';
import type { BrandVoice } from '../../../brand/domain/brand-profile.js';
import { HOOK_STYLES } from '../../../brand/domain/video-settings.js';
import {
  MAX_HOOK_CHARS,
  normalizeHookText,
  type ReelHook,
} from '../../domain/reel.js';

export const ReelHooksSchema = z.object({
  hooks: z
    .array(
      z.object({
        text: z.string().min(1).max(200),
        style: z.enum(HOOK_STYLES),
      }),
    )
    .max(6),
});

export const HOOK_OPTION_COUNT = 3;

/**
 * Writes short on-screen hooks for a Reel. Hooks are the church's framing of the moment; they never
 * render video and are never presented as the pastor's words.
 */
@Injectable()
export class ReelHookAIService {
  constructor(
    @Inject(LANGUAGE_MODEL) private readonly model: LanguageModelPort,
  ) {}

  async generate(input: {
    churchId: string;
    sermonId: string;
    excerpt: string;
    sermonTitle: string;
    speaker: string;
    mainTheme: string | null;
    summary: string | null;
    preferredStyle: string;
    voice: BrandVoice;
    signal?: AbortSignal;
  }): Promise<ReelHook[]> {
    const { voice } = input;
    const result = await this.model.generateStructured({
      context: {
        operation: 'reel.hooks',
        churchId: input.churchId,
        sermonId: input.sermonId,
      },
      schemaName: 'reel_hooks',
      schema: ReelHooksSchema,
      temperature: 0.7,
      signal: input.signal,
      system: [
        "You write the on-screen hook shown in the first seconds of a short video cut from a pastor's real sermon.",
        `Write ${HOOK_OPTION_COUNT} different options, each at most 12 words.`,
        "A hook must be faithful to what the pastor actually says in the excerpt. Never invent claims, promises, statistics, stories or quotes, and never put words in the pastor's mouth.",
        'No clickbait that misrepresents the message. No quotation marks. No hashtags.',
        `Styles: IMPACT (bold statement), QUESTION (a question the moment answers), MINIMAL (calm, few words), HIGHLIGHT (statement with one key phrase), TYPEWRITER (reads like a thought being typed). Prefer ${input.preferredStyle} for at least one option.`,
        voice.emojiUsage === 'none' || voice.emojiUsage === 'rarely'
          ? 'Do not use emojis.'
          : 'At most one emoji per hook.',
        voice.tone ? `Church tone: ${voice.tone}.` : '',
        voice.avoidPhrases.length
          ? `Never use these phrases: ${voice.avoidPhrases.join('; ')}.`
          : '',
        voice.preferredTerms.length
          ? `Preferred terms: ${voice.preferredTerms
              .map((term) =>
                term.insteadOf
                  ? `"${term.preferred}" instead of "${term.insteadOf}"`
                  : `"${term.preferred}"`,
              )
              .join(', ')}.`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      prompt: [
        `Sermon: ${input.sermonTitle} (${input.speaker})`,
        input.mainTheme ? `Main theme: ${input.mainTheme}` : '',
        input.summary ? `Sermon summary: ${input.summary}` : '',
        '',
        'What the pastor says in this video:',
        input.excerpt,
      ]
        .filter((line) => line !== '')
        .join('\n'),
      input: { excerpt: input.excerpt, preferredStyle: input.preferredStyle },
    });
    return cleanHooks(result.data.hooks, voice.avoidPhrases);
  }
}

/** Guardrails applied in code: length, no quote marks, avoided phrases, duplicates. */
export function cleanHooks(
  hooks: Array<{ text: string; style: ReelHook['style'] }>,
  avoidPhrases: string[],
): ReelHook[] {
  const avoided = avoidPhrases.map((phrase) => phrase.toLowerCase());
  const seen = new Set<string>();
  const clean: ReelHook[] = [];
  for (const hook of hooks) {
    const text = normalizeHookText(hook.text).replace(/["“”]/g, '');
    const key = text.toLowerCase();
    if (!text || text.length > MAX_HOOK_CHARS || seen.has(key)) continue;
    if (avoided.some((phrase) => phrase && key.includes(phrase))) continue;
    seen.add(key);
    clean.push({ text, style: hook.style });
    if (clean.length === HOOK_OPTION_COUNT) break;
  }
  return clean;
}
