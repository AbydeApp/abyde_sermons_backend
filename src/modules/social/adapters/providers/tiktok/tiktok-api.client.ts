import type { SocialObserverPort } from '../../ports.js';
import {
  bearer,
  form,
  SocialHttpClient,
  type SocialHttpRequest,
  type SocialHttpResponse,
} from '../shared/social-http.client.js';
import { mapTikTokError } from './tiktok.errors.js';
import type {
  TikTokConfig,
  TikTokEnvelope,
  TikTokOAuthErrorBody,
} from './tiktok.types.js';

export const TIKTOK_API_URL = 'https://open.tiktokapis.com';
export const TIKTOK_AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';

type CallOptions = Pick<SocialHttpRequest, 'decisive' | 'signal' | 'timeoutMs'>;

/**
 * Thin TikTok v2 client: bearer tokens in headers, client secrets and refresh tokens in POST
 * bodies (never in URLs), and TikTok's "error inside a 2xx body" convention turned into errors.
 */
export class TikTokApiClient {
  readonly http: SocialHttpClient;

  constructor(
    config: Pick<TikTokConfig, 'timeoutMs'>,
    observer: SocialObserverPort,
  ) {
    this.http = new SocialHttpClient({
      provider: 'tiktok',
      timeoutMs: config.timeoutMs,
      observer,
      requestIdHeaders: ['x-tt-logid'],
    });
  }

  /** OAuth endpoints (`/v2/oauth/...`): form-encoded, and errors may come back with HTTP 200. */
  async oauth<T>(
    operation: string,
    path: string,
    params: Record<string, string | undefined>,
    options: CallOptions = {},
  ): Promise<T> {
    const request: SocialHttpRequest = {
      operation,
      method: 'POST',
      url: `${TIKTOK_API_URL}${path}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache',
      },
      body: form(params),
      ...options,
    };
    const { body, response } = await this.http.json<T & TikTokOAuthErrorBody>(
      request,
      mapTikTokError,
    );
    if (typeof body?.error === 'string' && body.error)
      throw mapTikTokError(response, request);
    return body;
  }

  /** GET on the v2 API; returns the envelope's `data`. */
  async get<T>(
    operation: string,
    path: string,
    token: string,
    params: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const query = new URLSearchParams(params).toString();
    return this.unwrap<T>({
      operation,
      url: `${TIKTOK_API_URL}${path}${query ? `?${query}` : ''}`,
      headers: bearer(token),
      signal,
    });
  }

  /** JSON POST on the v2 API; returns the envelope's `data`. */
  async post<T>(
    operation: string,
    path: string,
    token: string,
    body: unknown,
    options: CallOptions = {},
  ): Promise<T> {
    return this.unwrap<T>({
      operation,
      method: 'POST',
      url: `${TIKTOK_API_URL}${path}`,
      headers: {
        ...bearer(token),
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...options,
    });
  }

  private async unwrap<T>(request: SocialHttpRequest): Promise<T> {
    const { body, response } = await this.http.json<TikTokEnvelope<T> | null>(
      request,
      mapTikTokError,
    );
    if (hasApiError(response)) throw mapTikTokError(response, request);
    return (preciseBody<T>(response.text, body)?.data ?? {}) as T;
  }
}

/**
 * Re-reads the body with integers of 16+ digits as strings: TikTok ids are 64-bit and
 * JSON.parse would silently round them.
 */
function preciseBody<T>(
  text: string,
  parsed: TikTokEnvelope<T> | null,
): TikTokEnvelope<T> | null {
  if (!/\d{16,}/.test(text)) return parsed;
  try {
    return JSON.parse(
      text.replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"'),
    ) as TikTokEnvelope<T>;
  } catch {
    return parsed;
  }
}

/** A 2xx whose envelope still reports an error code other than `ok`. */
const hasApiError = (response: SocialHttpResponse): boolean => {
  const error = (response.json as TikTokEnvelope<unknown> | null)?.error;
  return (
    typeof error?.code === 'string' && error.code !== '' && error.code !== 'ok'
  );
};
