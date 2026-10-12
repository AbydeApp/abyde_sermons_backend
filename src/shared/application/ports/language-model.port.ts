import type { ZodType } from 'zod';

export const LANGUAGE_MODEL = Symbol('LANGUAGE_MODEL');

/** Attributes every AI call to a church/sermon for cost metering and traceability. */
export interface AICallContext {
  operation: string;
  churchId?: string;
  sermonId?: string;
}

export interface StructuredGenerationRequest<T> {
  context: AICallContext;
  /** Stable name for the output schema (used by providers and fakes). */
  schemaName: string;
  schema: ZodType<T>;
  system: string;
  prompt: string;
  /** Structured inputs the prompt was rendered from (used by deterministic fakes; never logged). */
  input: Record<string, unknown>;
  temperature?: number;
  /** Aborts the provider call (job time limit, shutdown). */
  signal?: AbortSignal;
}

export interface StructuredGenerationResult<T> {
  data: T;
  provider: string;
  model: string;
}

export interface EmbeddingRequest {
  context: AICallContext;
  inputs: string[];
  signal?: AbortSignal;
}

export interface EmbeddingResult {
  vectors: number[][];
  provider: string;
  model: string;
}

/**
 * Provider-agnostic model access. Adapters (OpenAI, Anthropic, fakes) implement this; application
 * services own prompts and validate every structured result against its Zod schema.
 */
export interface LanguageModelPort {
  generateStructured<T>(
    request: StructuredGenerationRequest<T>,
  ): Promise<StructuredGenerationResult<T>>;
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}

export const EMBEDDING_DIMENSIONS = 1536;

/** Raised when a provider returns output that fails schema validation. */
export class InvalidModelOutputError extends Error {
  constructor(
    readonly schemaName: string,
    detail: string,
  ) {
    super(`Model output for ${schemaName} failed validation: ${detail}`);
    this.name = 'InvalidModelOutputError';
  }
}
