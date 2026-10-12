/** Minimal OpenAI HTTP client. Provider types never leave the infrastructure layer. */
export class OpenAIHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OpenAIHttpError';
  }
}

/** Errors that say the provider is struggling (not that our request was wrong). */
export const isProviderFailure = (error: unknown): boolean =>
  !(error instanceof OpenAIHttpError) ||
  error.status === 429 ||
  error.status >= 500;

export interface OpenAIRequestOptions {
  baseUrl: string;
  apiKey: string;
  path: string;
  body: BodyInit;
  json?: boolean;
  /** Hard limit for this single attempt; the request is aborted when it passes. */
  timeoutMs: number;
  /** Caller's abort signal (job time limit, shutdown), combined with the timeout. */
  signal?: AbortSignal;
}

/**
 * One attempt, with a timeout that really aborts the request. This client never retries:
 * background jobs are retried by the queue (with backoff) and interactive requests by the caller,
 * so there is exactly one retry layer and attempts never multiply.
 */
export async function openAIRequest<T>(
  options: OpenAIRequestOptions,
): Promise<T> {
  const response = await fetch(`${options.baseUrl}${options.path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      ...(options.json === false ? {} : { 'Content-Type': 'application/json' }),
    },
    body: options.body,
    signal: options.signal
      ? AbortSignal.any([
          options.signal,
          AbortSignal.timeout(options.timeoutMs),
        ])
      : AbortSignal.timeout(options.timeoutMs),
  });
  if (response.ok) return (await response.json()) as T;
  // Error bodies can echo input; keep only the provider's error message.
  const detail = await response
    .json()
    .then((body: { error?: { message?: string } }) => body.error?.message ?? '')
    .catch(() => '');
  throw new OpenAIHttpError(
    response.status,
    `OpenAI ${options.path} responded ${response.status}: ${detail.slice(0, 300)}`,
  );
}
