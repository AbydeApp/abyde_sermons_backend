import { Logger } from '@nestjs/common';
import {
  DependencyGuard,
  DependencyUnavailableError,
} from '../../../../../shared/infrastructure/resilience/dependency-guard.js';
import type { SocialObserverPort } from '../../../application/ports/out/social-support.ports.js';
import {
  type SocialErrorCode,
  SocialProviderError,
} from '../../../domain/social-errors.js';
import type { SocialProviderId } from '../../../domain/social-platform.js';

export interface SocialHttpConfig {
  provider: SocialProviderId;
  /** Per attempt; every call is a single attempt (the queue owns retries). */
  timeoutMs: number;
  observer: SocialObserverPort;
  /** Response headers carrying the provider's request id, for support tickets and logs. */
  requestIdHeaders: string[];
  /** Concurrent calls allowed per process (bulkhead). */
  maxConcurrent?: number;
}

export interface SocialHttpRequest {
  /** Stable name for metrics and logs, e.g. `instagram.media_publish`. */
  operation: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  /**
   * The call that makes content public. A network failure after sending it means the outcome is
   * unknown; for any other call it simply means nothing was published.
   */
  decisive?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Default `error`; resumable uploads that answer 308 use `manual`. */
  redirect?: RequestRedirect;
}

export interface SocialHttpResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  /** Parsed JSON body, or null when the body is empty or not JSON. */
  json: unknown;
  /** Raw body, for values JSON.parse would corrupt (64-bit integer ids). */
  text: string;
  requestId?: string;
}

/** Thrown for non-2xx responses after the adapter's mapper had its say (see `classifyHttp`). */
export type HttpErrorMapper = (
  response: SocialHttpResponse,
  request: SocialHttpRequest,
) => SocialProviderError;

/**
 * The one HTTP path every social adapter uses: explicit timeout wired to the actual request,
 * a circuit breaker + concurrency cap per provider, metrics per operation, and request ids in
 * logs. Tokens travel in headers or bodies, never in logged URLs; nothing here logs bodies.
 */
export class SocialHttpClient {
  private readonly logger: Logger;
  private readonly guard: DependencyGuard;

  constructor(private readonly config: SocialHttpConfig) {
    this.logger = new Logger(`Social:${config.provider}`);
    this.guard = new DependencyGuard(`social-${config.provider}`, {
      maxConcurrent: config.maxConcurrent ?? 16,
      failureThreshold: 5,
      openMs: 60_000,
      // Only provider-side trouble opens the circuit; rejected content or tokens do not.
      isFailure: (error) =>
        error instanceof SocialProviderError &&
        error.code === 'PROVIDER_UNAVAILABLE',
    });
  }

  /** Sends the request; resolves for any HTTP status, throws SocialProviderError otherwise. */
  async send(request: SocialHttpRequest): Promise<SocialHttpResponse> {
    const startedAt = Date.now();
    try {
      const response = await this.guard.run(() => this.fetchOnce(request));
      this.record(request, startedAt, response.ok ? undefined : 'http');
      return response;
    } catch (error) {
      const mapped = this.mapTransportError(error, request);
      this.record(request, startedAt, mapped.code);
      throw mapped;
    }
  }

  /** `send` + `mapError` for any non-2xx status. */
  async json<T>(
    request: SocialHttpRequest,
    mapError: HttpErrorMapper,
  ): Promise<{ body: T; response: SocialHttpResponse }> {
    const response = await this.send(request);
    if (!response.ok) {
      const error = mapError(response, request);
      this.logger.warn(
        {
          operation: request.operation,
          status: response.status,
          errorCode: error.code,
          providerRequestId: response.requestId,
          detail: error.message.slice(0, 300),
        },
        'Provider call failed',
      );
      throw error;
    }
    return { body: response.json as T, response };
  }

  private async fetchOnce(
    request: SocialHttpRequest,
  ): Promise<SocialHttpResponse> {
    const timeout = AbortSignal.timeout(
      request.timeoutMs ?? this.config.timeoutMs,
    );
    const signal = request.signal
      ? AbortSignal.any([timeout, request.signal])
      : timeout;
    const response = await fetch(request.url, {
      method: request.method ?? 'GET',
      headers: request.headers,
      body: request.body,
      signal,
      redirect: request.redirect ?? 'error',
      // Streams (video uploads) need half-duplex; harmless for other bodies.
      ...(request.body instanceof ReadableStream ? { duplex: 'half' } : {}),
    } as RequestInit);
    const text = await response.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      json,
      text,
      requestId: this.config.requestIdHeaders
        .map((name) => response.headers.get(name))
        .find((value): value is string => Boolean(value)),
    };
  }

  private mapTransportError(
    error: unknown,
    request: SocialHttpRequest,
  ): SocialProviderError {
    if (error instanceof SocialProviderError) return error;
    if (error instanceof DependencyUnavailableError) {
      // Fails fast without calling the provider: nothing was sent.
      return new SocialProviderError(
        'PROVIDER_UNAVAILABLE',
        `${this.config.provider} circuit ${error.reason}`,
        { retryable: true, outcome: 'not_published' },
      );
    }
    const aborted =
      (error as Error)?.name === 'AbortError' ||
      (error as Error)?.name === 'TimeoutError';
    return new SocialProviderError(
      'PROVIDER_UNAVAILABLE',
      `${request.operation} ${aborted ? 'timed out' : 'network error'}: ${(error as Error)?.message ?? 'unknown'}`,
      {
        retryable: !request.decisive,
        outcome: request.decisive ? 'unknown' : 'not_published',
      },
    );
  }

  private record(
    request: SocialHttpRequest,
    startedAt: number,
    failure: SocialErrorCode | 'http' | undefined,
  ): void {
    this.config.observer.providerCall({
      provider: this.config.provider,
      operation: request.operation,
      durationMs: Date.now() - startedAt,
      outcome: failure ? 'failure' : 'success',
      errorCode: failure && failure !== 'http' ? failure : undefined,
    });
  }
}

/**
 * Status-based fallback classification shared by every adapter (each adds provider error codes
 * on top). A 4xx means the provider refused, so nothing was published; a 5xx on the decisive call
 * leaves the outcome unknown.
 */
export function classifyHttp(
  response: SocialHttpResponse,
  request: SocialHttpRequest,
  detail: string,
): SocialProviderError {
  const options = {
    providerRequestId: response.requestId,
    httpStatus: response.status,
  };
  const status = response.status;
  if (status === 401)
    return new SocialProviderError('AUTH_EXPIRED', detail, options);
  if (status === 403)
    return new SocialProviderError('PERMISSION_DENIED', detail, options);
  if (status === 429)
    return new SocialProviderError('RATE_LIMITED', detail, options);
  if (status === 413 || status === 415)
    return new SocialProviderError('INVALID_MEDIA', detail, options);
  if (status >= 500)
    return new SocialProviderError('PROVIDER_UNAVAILABLE', detail, {
      ...options,
      retryable: !request.decisive,
      outcome: request.decisive ? 'unknown' : 'not_published',
    });
  if (status >= 400)
    return new SocialProviderError('UNSUPPORTED_CONTENT', detail, options);
  return new SocialProviderError('UNKNOWN', detail, options);
}

export const form = (
  params: Record<string, string | undefined>,
): URLSearchParams =>
  new URLSearchParams(
    Object.entries(params).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
