import type { SocialObserverPort } from '../../../application/ports/out/social-support.ports.js';
import { SocialProviderError } from '../../../domain/social-errors.js';
import {
  bearer,
  form,
  SocialHttpClient,
  type SocialHttpRequest,
  type SocialHttpResponse,
} from '../shared/social-http.client.js';
import { mapLinkedInError } from './linkedin.errors.js';
import type {
  LinkedInConfig,
  LinkedInTokenResponse,
  LinkedInUserInfo,
} from './linkedin.types.js';

const API_BASE = 'https://api.linkedin.com';
const OAUTH_BASE = 'https://www.linkedin.com/oauth/v2';
/** Per upload request (one image, or one ~4 MB video part). */
const MIN_UPLOAD_TIMEOUT_MS = 120_000;

type CallOptions = Pick<SocialHttpRequest, 'decisive' | 'signal'>;

/**
 * Thin client for LinkedIn's versioned REST API (`/rest/*`) and OAuth endpoints. The API version
 * comes from configuration through `restHeaders`, never from call sites. Tokens travel only in the
 * Authorization header or form bodies.
 */
export class LinkedInApiClient {
  readonly http: SocialHttpClient;

  constructor(
    private readonly config: LinkedInConfig,
    observer: SocialObserverPort,
  ) {
    this.http = new SocialHttpClient({
      provider: 'linkedin',
      timeoutMs: config.timeoutMs,
      observer,
      // `x-restli-id` is the created entity's URN, not a request id.
      requestIdHeaders: ['x-li-uuid', 'x-li-request-id'],
    });
  }

  get authorizationUrl(): string {
    return `${OAUTH_BASE}/authorization`;
  }

  get uploadTimeoutMs(): number {
    return Math.max(this.config.timeoutMs, MIN_UPLOAD_TIMEOUT_MS);
  }

  restUrl(path: string): string {
    return `${API_BASE}/rest/${path}`;
  }

  /** Headers every versioned call needs; the one place the API version is applied. */
  restHeaders(
    token: string,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    return {
      ...bearer(token),
      'LinkedIn-Version': this.config.apiVersion,
      'X-Restli-Protocol-Version': '2.0.0',
      ...extra,
    };
  }

  async get<T>(
    operation: string,
    path: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<T> {
    return (
      await this.http.json<T>(
        {
          operation,
          url: this.restUrl(path),
          headers: this.restHeaders(token),
          signal,
        },
        mapLinkedInError,
      )
    ).body;
  }

  /** JSON POST; returns the response too, since created URNs arrive in `x-restli-id`. */
  async post<T>(
    operation: string,
    path: string,
    token: string,
    payload: unknown,
    options: CallOptions = {},
  ): Promise<{ body: T; response: SocialHttpResponse }> {
    return this.http.json<T>(
      {
        operation,
        method: 'POST',
        url: this.restUrl(path),
        headers: this.restHeaders(token, {
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(payload),
        decisive: options.decisive,
        signal: options.signal,
      },
      mapLinkedInError,
    );
  }

  async delete(
    operation: string,
    path: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.http.send({
      operation,
      method: 'DELETE',
      url: this.restUrl(path),
      headers: this.restHeaders(token, { 'X-RestLi-Method': 'DELETE' }),
      signal,
    });
    // Deletes are idempotent at LinkedIn (204 again); a 404 means it is already gone.
    if (!response.ok && response.status !== 404)
      throw mapLinkedInError(response, { operation, url: this.restUrl(path) });
  }

  /** PUT bytes to a pre-signed upload URL. Returns the response so callers can read `ETag`. */
  async upload(
    operation: string,
    url: string,
    body: BodyInit,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<SocialHttpResponse> {
    return (
      await this.http.json(
        {
          operation,
          method: 'PUT',
          url,
          headers: { 'Content-Type': 'application/octet-stream', ...headers },
          body,
          timeoutMs: this.uploadTimeoutMs,
          signal,
        },
        mapLinkedInError,
      )
    ).response;
  }

  /** OIDC userinfo lives on the unversioned `/v2` API. */
  async userInfo(token: string): Promise<LinkedInUserInfo> {
    return (
      await this.http.json<LinkedInUserInfo>(
        {
          operation: 'oauth.userinfo',
          url: `${API_BASE}/v2/userinfo`,
          headers: bearer(token),
        },
        mapLinkedInError,
      )
    ).body;
  }

  async token(
    operation: string,
    params: Record<string, string | undefined>,
  ): Promise<LinkedInTokenResponse> {
    const { body } = await this.http.json<LinkedInTokenResponse>(
      {
        operation,
        method: 'POST',
        url: `${OAUTH_BASE}/accessToken`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({
          ...params,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }),
      },
      mapLinkedInError,
    );
    if (!body?.access_token)
      throw new SocialProviderError(
        'UNKNOWN',
        `${operation}: response had no access token`,
      );
    return body;
  }

  async revoke(token: string): Promise<void> {
    await this.http.json(
      {
        operation: 'oauth.revoke',
        method: 'POST',
        url: `${OAUTH_BASE}/revoke`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          token,
        }),
      },
      mapLinkedInError,
    );
  }
}
