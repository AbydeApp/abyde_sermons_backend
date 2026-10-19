import type { SocialObserverPort } from '../../ports.js';
import {
  bearer,
  form,
  SocialHttpClient,
  type SocialHttpRequest,
} from '../shared/social-http.client.js';
import { mapGraphError } from './meta.errors.js';
import type { MetaConfig } from './meta.types.js';

/** Thin Graph API client: versioned base URLs, bearer tokens in headers, Graph error mapping. */
export class MetaApiClient {
  readonly http: SocialHttpClient;

  constructor(
    private readonly config: MetaConfig,
    observer: SocialObserverPort,
  ) {
    this.http = new SocialHttpClient({
      provider: 'meta',
      timeoutMs: config.timeoutMs,
      observer,
      requestIdHeaders: ['x-fb-trace-id', 'x-fb-request-id'],
    });
  }

  get graphUrl(): string {
    return `https://graph.facebook.com/${this.config.graphVersion}`;
  }

  get videoUrl(): string {
    return `https://graph-video.facebook.com/${this.config.graphVersion}`;
  }

  get dialogUrl(): string {
    return `https://www.facebook.com/${this.config.graphVersion}/dialog/oauth`;
  }

  async get<T>(
    operation: string,
    path: string,
    token: string,
    params: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const query = new URLSearchParams(params).toString();
    return (
      await this.http.json<T>(
        {
          operation,
          url: `${this.graphUrl}/${path}${query ? `?${query}` : ''}`,
          headers: bearer(token),
          signal,
        },
        mapGraphError,
      )
    ).body;
  }

  async post<T>(
    operation: string,
    url: string,
    token: string | undefined,
    params: Record<string, string | undefined>,
    options: Pick<
      SocialHttpRequest,
      'decisive' | 'signal' | 'headers' | 'timeoutMs'
    > = {},
  ): Promise<T> {
    return (
      await this.http.json<T>(
        {
          operation,
          method: 'POST',
          url,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            ...(token ? bearer(token) : {}),
            ...options.headers,
          },
          body: form(params),
          decisive: options.decisive,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
        },
        mapGraphError,
      )
    ).body;
  }

  async delete(
    operation: string,
    path: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.http.json(
      {
        operation,
        method: 'DELETE',
        url: `${this.graphUrl}/${path}`,
        headers: bearer(token),
        signal,
      },
      mapGraphError,
    );
  }
}
