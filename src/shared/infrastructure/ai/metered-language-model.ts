import type {
  AICallContext,
  EmbeddingRequest,
  EmbeddingResult,
  LanguageModelPort,
  StructuredGenerationRequest,
  StructuredGenerationResult,
} from '../../application/ports/language-model.port.js';
import type {
  AIUsageRecorderPort,
  UsageMeterPort,
} from '../../application/ports/usage-meter.port.js';
import { withTokenUsageScope } from './token-usage.js';

export interface ModelPricing {
  textInputPerMTok: number;
  textOutputPerMTok: number;
  embeddingPerMTok: number;
}

export interface AICallObserver {
  observe(
    operation: string,
    provider: string,
    status: 'SUCCEEDED' | 'FAILED',
    latencyMs: number,
    cost: number,
  ): void;
}

/**
 * Decorator that records an AIUsageLog row and a customer usage event for every model call.
 * Prompts and responses are never logged — only token counts, latency, cost and status.
 */
export class MeteredLanguageModel implements LanguageModelPort {
  constructor(
    private readonly inner: LanguageModelPort,
    private readonly providerName: string,
    private readonly models: { text: string; embedding: string },
    private readonly pricing: ModelPricing,
    private readonly recorder: AIUsageRecorderPort,
    private readonly meter: UsageMeterPort,
    private readonly observer?: AICallObserver,
  ) {}

  async generateStructured<T>(
    request: StructuredGenerationRequest<T>,
  ): Promise<StructuredGenerationResult<T>> {
    return this.metered(
      request.context,
      this.models.text,
      'TEXT_GENERATION',
      (input, output) =>
        (input * this.pricing.textInputPerMTok +
          output * this.pricing.textOutputPerMTok) /
        1_000_000,
      () => this.inner.generateStructured(request),
    );
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    return this.metered(
      request.context,
      this.models.embedding,
      'EMBEDDING',
      (input) => (input * this.pricing.embeddingPerMTok) / 1_000_000,
      () => this.inner.embed(request),
    );
  }

  private async metered<R extends { model: string }>(
    context: AICallContext,
    defaultModel: string,
    unit: 'TEXT_GENERATION' | 'EMBEDDING',
    cost: (inputTokens: number, outputTokens: number) => number,
    call: () => Promise<R>,
  ): Promise<R> {
    const startedAt = Date.now();
    const { scope, result } = withTokenUsageScope(call);
    let status: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED';
    let model = defaultModel;
    try {
      const value = await result;
      model = value.model;
      return value;
    } catch (error) {
      status = 'FAILED';
      throw error;
    } finally {
      const latencyMs = Date.now() - startedAt;
      const estimatedCost = cost(scope.inputTokens, scope.outputTokens);
      this.observer?.observe(
        context.operation,
        this.providerName,
        status,
        latencyMs,
        estimatedCost,
      );
      // Metering must never break the business operation.
      await Promise.allSettled([
        this.recorder.record({
          churchId: context.churchId,
          sermonId: context.sermonId,
          operation: context.operation,
          provider: this.providerName,
          model,
          inputTokens: scope.inputTokens,
          outputTokens: scope.outputTokens,
          estimatedCost,
          latencyMs,
          status,
        }),
        status === 'SUCCEEDED' && context.churchId
          ? this.meter.record({
              churchId: context.churchId,
              unit,
              quantity: 1,
              sermonId: context.sermonId,
            })
          : Promise.resolve(),
      ]);
    }
  }
}
