import {
  type SocialErrorCode,
  SocialProviderError,
} from '../../../domain/social-errors.js';
import type {
  SocialHttpRequest,
  SocialHttpResponse,
} from '../shared/social-http.client.js';
import { classifyHttp } from '../shared/social-http.client.js';
import type { XProblem } from './x.types.js';

/** v1.1-style codes the media endpoints still return in `errors[]`. */
const AUTH_CODES = new Set([32, 89, 215]);
const RATE_LIMIT_CODES = new Set([88, 185]);
const DUPLICATE_CODES = new Set([187]);
const MEDIA_CODES = new Set([323, 324, 325]);

/** Operations that upload bytes: a 400 there means X rejected the file itself. */
const isMediaOperation = (request: SocialHttpRequest) =>
  request.operation.startsWith('x.media');

/**
 * X API v2 / OAuth error body → normalised social error. Falls back to HTTP status rules.
 * The diagnostic carries X's own wording and the rate-limit reset, never request bodies or tokens.
 */
export function mapXError(
  response: SocialHttpResponse,
  request: SocialHttpRequest,
): SocialProviderError {
  const body = (response.json as XProblem | null) ?? {};
  const first = body.errors?.[0];
  const code = first?.code;
  const type = body.type ?? first?.type ?? '';
  const text =
    body.detail ??
    body.error_description ??
    first?.detail ??
    first?.message ??
    body.title ??
    '';
  const reset = response.headers.get('x-rate-limit-reset');
  const detail =
    `${request.operation}: ${response.status} ${body.error ?? type} #${code ?? '-'} ${text}${
      reset ? ` (rate limit resets at ${reset})` : ''
    }`.trim();
  const options = {
    providerRequestId: response.requestId,
    httpStatus: response.status,
  };
  const as = (normalised: SocialErrorCode, retryable?: boolean) =>
    new SocialProviderError(normalised, detail, { ...options, retryable });
  const status = response.status;

  // Token / revoke endpoints (RFC 6749): an expired code or a rotated refresh token.
  if (body.error === 'invalid_grant' || body.error === 'invalid_request')
    return as('AUTH_EXPIRED');

  if (status === 401 || (code !== undefined && AUTH_CODES.has(code)))
    return as('AUTH_EXPIRED');
  if (
    status === 429 ||
    type.endsWith('/usage-capped') ||
    (code && RATE_LIMIT_CODES.has(code))
  )
    return as('RATE_LIMITED');
  // X refuses identical posts. The earlier post already exists; this one was not published.
  if (
    type.endsWith('/duplicate-content') ||
    (code !== undefined && DUPLICATE_CODES.has(code)) ||
    /duplicate/i.test(text)
  )
    return as('UNSUPPORTED_CONTENT');
  if (status === 403) return as('PERMISSION_DENIED');
  if (
    (code !== undefined && MEDIA_CODES.has(code)) ||
    (status === 400 && isMediaOperation(request))
  )
    return as('INVALID_MEDIA');
  return classifyHttp(response, request, detail);
}
