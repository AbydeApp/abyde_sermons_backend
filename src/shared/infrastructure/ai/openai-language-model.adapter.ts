import { Inject, Injectable } from '@nestjs/common';
import {
  type EmbeddingRequest,
  type EmbeddingResult,
  EMBEDDING_DIMENSIONS,
  InvalidModelOutputError,
  type LanguageModelPort,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
} from '../../application/ports/language-model.port.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/env.schema.js';
import { DependencyGuard } from '../resilience/dependency-guard.js';
import { isProviderFailure, openAIRequest } from './openai-http.js';
import { toStrictJsonSchema } from './strict-json-schema.js';
import { reportTokenUsage } from './token-usage.js';

interface ChatCompletionResponse {
  model: string;
  choices: Array<{
    message: { content: string | null; refusal?: string | null };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface EmbeddingResponse {
  model: string;
  data: Array<{ index: number; embedding: number[] }>;
  usage?: { prompt_tokens: number };
}

@Injectable()
export class OpenAILanguageModelAdapter implements LanguageModelPort {
  /** Circuit breaker + concurrency cap: a slow or failing provider cannot occupy every request. */
  private readonly guard = new DependencyGuard('openai', {
    maxConcurrent: 16,
    failureThreshold: 5,
    openMs: 30_000,
    isFailure: isProviderFailure,
  });

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async generateStructured<T>(
    request: StructuredGenerationRequest<T>,
  ): Promise<StructuredGenerationResult<T>> {
    const response = await this.guard.run(() =>
      openAIRequest<ChatCompletionResponse>({
        baseUrl: this.config.AI_OPENAI_BASE_URL,
        apiKey: this.config.AI_OPENAI_API_KEY ?? '',
        path: '/chat/completions',
        timeoutMs: 120_000,
        signal: request.signal,
        body: JSON.stringify({
          model: this.config.AI_TEXT_MODEL,
          temperature: request.temperature ?? 0.4,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.prompt },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: request.schemaName,
              strict: true,
              schema: toStrictJsonSchema(request.schema),
            },
          },
        }),
      }),
    );
    reportTokenUsage(
      response.usage?.prompt_tokens ?? 0,
      response.usage?.completion_tokens ?? 0,
    );

    const choice = response.choices[0];
    if (!choice?.message.content) {
      throw new InvalidModelOutputError(
        request.schemaName,
        choice?.message.refusal
          ? 'model refused'
          : `empty (${choice?.finish_reason ?? 'no choice'})`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(choice.message.content);
    } catch {
      throw new InvalidModelOutputError(
        request.schemaName,
        'response was not valid JSON',
      );
    }
    const validated = request.schema.safeParse(parsed);
    if (!validated.success) {
      throw new InvalidModelOutputError(
        request.schemaName,
        validated.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
      );
    }
    return { data: validated.data, provider: 'openai', model: response.model };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const response = await this.guard.run(() =>
      openAIRequest<EmbeddingResponse>({
        baseUrl: this.config.AI_OPENAI_BASE_URL,
        apiKey: this.config.AI_OPENAI_API_KEY ?? '',
        path: '/embeddings',
        timeoutMs: 60_000,
        signal: request.signal,
        body: JSON.stringify({
          model: this.config.AI_EMBEDDING_MODEL,
          input: request.inputs,
          dimensions: EMBEDDING_DIMENSIONS,
        }),
      }),
    );
    reportTokenUsage(response.usage?.prompt_tokens ?? 0, 0);
    const vectors = [...response.data]
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
    return { vectors, provider: 'openai', model: response.model };
  }
}
