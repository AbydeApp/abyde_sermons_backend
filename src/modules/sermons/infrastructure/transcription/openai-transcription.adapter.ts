import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  isProviderFailure,
  openAIRequest,
} from '../../../../shared/infrastructure/ai/openai-http.js';
import { DependencyGuard } from '../../../../shared/infrastructure/resilience/dependency-guard.js';
import type {
  TranscriptionPort,
  TranscriptionResult,
} from '../../application/ports/out/processing.ports.js';

interface VerboseTranscription {
  language?: string;
  segments?: Array<{ start: number; end: number; text: string }>;
  words?: Array<{ word: string; start: number; end: number }>;
  text: string;
}

type TimedWord = { text: string; startMs: number; endMs: number };

/**
 * Assigns each word to the segment its midpoint falls in. Words the provider placed outside every
 * segment (rare rounding at the edges) go to the nearest one, so no spoken word is dropped.
 */
export function attachWords(
  segments: Array<{ startMs: number; endMs: number }>,
  words: TimedWord[],
): TimedWord[][] {
  const buckets: TimedWord[][] = segments.map(() => []);
  if (segments.length === 0) return buckets;
  for (const word of words) {
    const midpoint = (word.startMs + word.endMs) / 2;
    let index = segments.findIndex(
      (segment) => midpoint >= segment.startMs && midpoint < segment.endMs,
    );
    if (index === -1) {
      let best = Number.POSITIVE_INFINITY;
      segments.forEach((segment, candidate) => {
        const distance = Math.min(
          Math.abs(midpoint - segment.startMs),
          Math.abs(midpoint - segment.endMs),
        );
        if (distance < best) {
          best = distance;
          index = candidate;
        }
      });
    }
    buckets[index]?.push(word);
  }
  return buckets;
}

export interface TranscriptionCostRecorder {
  record(input: {
    churchId: string;
    sermonId: string;
    provider: string;
    model: string;
    durationMs: number;
    latencyMs: number;
    ok: boolean;
  }): Promise<void>;
}

/**
 * OpenAI speech-to-text with segment and word timestamps (verbose_json). Files are pre-chunked
 * under the upload limit. Word timings drive frame-accurate Reel captions.
 */
export class OpenAITranscriptionAdapter implements TranscriptionPort {
  private readonly guard = new DependencyGuard('openai-transcription', {
    maxConcurrent: 4,
    failureThreshold: 4,
    openMs: 60_000,
    isFailure: isProviderFailure,
  });

  constructor(
    private readonly options: {
      apiKey: string;
      baseUrl: string;
      model: string;
    },
    private readonly costs: TranscriptionCostRecorder,
  ) {}

  async transcribe(input: {
    filePath: string;
    durationMs: number;
    context: { churchId: string; sermonId: string };
    signal?: AbortSignal;
  }): Promise<TranscriptionResult> {
    const startedAt = Date.now();
    let ok = false;
    try {
      const form = new FormData();
      form.append(
        'file',
        new Blob([await readFile(input.filePath)], { type: 'audio/mpeg' }),
        basename(input.filePath),
      );
      form.append('model', this.options.model);
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'segment');
      form.append('timestamp_granularities[]', 'word');
      const response = await this.guard.run(() =>
        openAIRequest<VerboseTranscription>({
          baseUrl: this.options.baseUrl,
          apiKey: this.options.apiKey,
          path: '/audio/transcriptions',
          body: form,
          json: false,
          timeoutMs: 5 * 60 * 1000,
          signal: input.signal,
        }),
      );
      ok = true;
      const timed = (
        response.segments ?? [
          { start: 0, end: input.durationMs / 1000, text: response.text },
        ]
      ).map((segment) => ({
        text: segment.text.trim(),
        startMs: Math.round(segment.start * 1000),
        endMs: Math.round(segment.end * 1000),
      }));
      const words = attachWords(
        timed,
        (response.words ?? []).map((word) => ({
          text: word.word.trim(),
          startMs: Math.round(word.start * 1000),
          endMs: Math.round(word.end * 1000),
        })),
      );
      const fragments = timed.map((segment, index) => {
        const segmentWords = words[index] ?? [];
        return segmentWords.length > 0
          ? { ...segment, words: segmentWords }
          : segment;
      });
      return {
        provider: 'openai',
        language: response.language ?? null,
        fragments,
      };
    } finally {
      await this.costs
        .record({
          ...input.context,
          provider: 'openai',
          model: this.options.model,
          durationMs: input.durationMs,
          latencyMs: Date.now() - startedAt,
          ok,
        })
        .catch(() => undefined);
    }
  }
}
