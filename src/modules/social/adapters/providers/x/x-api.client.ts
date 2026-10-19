import type { SocialObserverPort } from '../../ports.js';
import {
  bearer,
  form,
  SocialHttpClient,
  type SocialHttpRequest,
} from '../shared/social-http.client.js';
import { mapXError } from './x.errors.js';
import type { XConfig } from './x.types.js';

const API = 'https://api.x.com/2';

/** Every X URL in one place, so a moved endpoint is a one-line fix. */
export const X_ENDPOINTS = {
  authorize: 'https://x.com/i/oauth2/authorize',
  token: `${API}/oauth2/token`,
  revoke: `${API}/oauth2/revoke`,
  me: `${API}/users/me`,
  tweets: `${API}/tweets`,
  tweet: (id: string) => `${API}/tweets/${encodeURIComponent(id)}`,
  /** One-shot upload (images) and, with `command=STATUS`, processing status. */
  mediaUpload: `${API}/media/upload`,
  mediaInitialize: `${API}/media/upload/initialize`,
  mediaAppend: (id: string) =>
    `${API}/media/upload/${encodeURIComponent(id)}/append`,
  mediaFinalize: (id: string) =>
    `${API}/media/upload/${encodeURIComponent(id)}/finalize`,
  permalink: (username: string | undefined, id: string) =>
    username
      ? `https://x.com/${username}/status/${id}`
      : `https://x.com/i/web/status/${id}`,
} as const;

type CallOptions = Pick<
  SocialHttpRequest,
  'decisive' | 'signal' | 'timeoutMs'
> & {
  headers?: Record<string, string>;
};

/** Thin X API v2 client: bearer tokens in headers, X error mapping, one attempt per call. */
export class XApiClient {
  readonly http: SocialHttpClient;

  constructor(config: XConfig, observer: SocialObserverPort) {
    this.http = new SocialHttpClient({
      provider: 'x',
      timeoutMs: config.timeoutMs,
      observer,
      requestIdHeaders: ['x-transaction-id'],
    });
  }

  async get<T>(
    operation: string,
    url: string,
    token: string,
    params: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const query = new URLSearchParams(params).toString();
    return (
      await this.http.json<T>(
        {
          operation,
          url: query ? `${url}?${query}` : url,
          headers: bearer(token),
          signal,
        },
        mapXError,
      )
    ).body;
  }

  async postJson<T>(
    operation: string,
    url: string,
    token: string,
    body: unknown,
    options: CallOptions = {},
  ): Promise<T> {
    return this.send<T>(
      operation,
      url,
      { 'Content-Type': 'application/json', ...bearer(token) },
      JSON.stringify(body),
      options,
    );
  }

  /** Form-encoded POST; the OAuth endpoints pass Basic auth in `options.headers` instead of a token. */
  async postForm<T>(
    operation: string,
    url: string,
    params: Record<string, string | undefined>,
    options: CallOptions = {},
  ): Promise<T> {
    return this.send<T>(
      operation,
      url,
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      form(params),
      options,
    );
  }

  /** multipart/form-data POST; fetch sets the boundary header from the FormData body. */
  async postMultipart<T>(
    operation: string,
    url: string,
    token: string,
    body: FormData,
    options: CallOptions = {},
  ): Promise<T> {
    return this.send<T>(operation, url, bearer(token), body, options);
  }

  /** POST without a body (media finalize). */
  async postEmpty<T>(
    operation: string,
    url: string,
    token: string,
    options: CallOptions = {},
  ): Promise<T> {
    return this.send<T>(operation, url, bearer(token), undefined, options);
  }

  async delete<T>(
    operation: string,
    url: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<T> {
    return (
      await this.http.json<T>(
        { operation, method: 'DELETE', url, headers: bearer(token), signal },
        mapXError,
      )
    ).body;
  }

  private async send<T>(
    operation: string,
    url: string,
    headers: Record<string, string>,
    body: BodyInit | undefined,
    options: CallOptions,
  ): Promise<T> {
    return (
      await this.http.json<T>(
        {
          operation,
          method: 'POST',
          url,
          headers: { ...headers, ...options.headers },
          body,
          decisive: options.decisive,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
        },
        mapXError,
      )
    ).body;
  }
}

/** HTTP Basic client authentication for the confidential-client OAuth endpoints. */
export const basicAuth = (clientId: string, clientSecret: string) => ({
  Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
});
