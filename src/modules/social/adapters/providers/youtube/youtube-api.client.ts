import type { SocialObserverPort } from '../../ports.js';
import {
  bearer,
  form,
  SocialHttpClient,
  type SocialHttpRequest,
} from '../shared/social-http.client.js';
import { mapGoogleError } from './youtube.errors.js';
import type { YouTubeConfig } from './youtube.types.js';

export const GOOGLE_AUTHORIZE_URL =
  'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const YOUTUBE_API_URL = 'https://www.googleapis.com/youtube/v3';
export const YOUTUBE_UPLOAD_URL =
  'https://www.googleapis.com/upload/youtube/v3';

/**
 * Thin client over Google's OAuth and YouTube Data API v3 endpoints: bearer tokens in headers,
 * client secrets and refresh tokens in POST bodies, Google error mapping. Every call is a single
 * attempt through the shared social HTTP client (timeout, circuit breaker, metrics).
 */
export class YouTubeApiClient {
  readonly http: SocialHttpClient;

  constructor(config: YouTubeConfig, observer: SocialObserverPort) {
    this.http = new SocialHttpClient({
      provider: 'youtube',
      timeoutMs: config.timeoutMs,
      observer,
      // Google's JSON APIs carry no documented request-id header; errors are diagnosed from the
      // operation, status and `errors[].reason` instead.
      requestIdHeaders: [],
    });
  }

  async get<T>(
    operation: string,
    path: string,
    token: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T> {
    return (
      await this.http.json<T>(
        {
          operation,
          url: `${YOUTUBE_API_URL}/${path}?${new URLSearchParams(params).toString()}`,
          headers: bearer(token),
          signal,
        },
        mapGoogleError,
      )
    ).body;
  }

  async delete(
    operation: string,
    path: string,
    token: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.http.json(
      {
        operation,
        method: 'DELETE',
        url: `${YOUTUBE_API_URL}/${path}?${new URLSearchParams(params).toString()}`,
        headers: bearer(token),
        signal,
      },
      mapGoogleError,
    );
  }

  /** Form POST without a bearer token (OAuth token and revoke endpoints). */
  async postForm<T>(
    operation: string,
    url: string,
    params: Record<string, string | undefined>,
    signal?: AbortSignal,
  ): Promise<T> {
    return (
      await this.http.json<T>(
        {
          operation,
          method: 'POST',
          url,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form(params),
          signal,
        },
        mapGoogleError,
      )
    ).body;
  }

  /** Any other request (uploads), with Google error mapping for non-2xx answers. */
  async request<T>(
    request: SocialHttpRequest,
  ): Promise<{ body: T; headers: Headers }> {
    const { body, response } = await this.http.json<T>(request, mapGoogleError);
    return { body, headers: response.headers };
  }
}
