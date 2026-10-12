import type {
  SocialHttpRequest,
  SocialHttpResponse,
} from '../shared/social-http.client.js';
import { classifyHttp } from '../shared/social-http.client.js';
import {
  type SocialErrorCode,
  SocialProviderError,
} from '../../../domain/social-errors.js';
import type { LinkedInErrorBody } from './linkedin.types.js';

const TOKEN_CODES = new Set([
  'EXPIRED_ACCESS_TOKEN',
  'REVOKED_ACCESS_TOKEN',
  'INVALID_ACCESS_TOKEN',
  'EMPTY_ACCESS_TOKEN',
]);
/** 65600 invalid token, 65601 revoked by the member, 65602 expired. */
const TOKEN_SERVICE_CODES = new Set([65600, 65601, 65602]);
/** Rejected or unusable media (Images/Videos API error codes). */
const MEDIA_CODES = new Set([
  'MEDIA_ASSET_PROCESSING_FAILED',
  'EXPIRED_UPLOAD_URL',
  'INVALID_IMAGE_ID',
  'INVALID_VIDEO_ID',
  'UPDATING_ASSET_FAILED',
]);
/** The asset exists but its upload or processing has not finished yet. */
const NOT_READY_CODES = new Set(['MEDIA_ASSET_WAITING_UPLOAD']);
/** OAuth token endpoint: the code or refresh token is no longer usable. */
const DEAD_GRANT = /expired|revoked/i;

/**
 * LinkedIn error body → normalised social error. Rest.li errors look like
 * `{ status, serviceErrorCode, code, message }`; the OAuth endpoints answer
 * `{ error, error_description }`. Falls back to HTTP status rules.
 */
export function mapLinkedInError(
  response: SocialHttpResponse,
  request: SocialHttpRequest,
): SocialProviderError {
  const body = (response.json as LinkedInErrorBody | null) ?? {};
  const code = body.code ?? body.error;
  const message = body.message ?? body.error_description ?? '';
  const detail =
    `${request.operation}: ${response.status} ${code ?? ''} #${body.serviceErrorCode ?? '-'} ${message}`.trim();
  const options = {
    providerRequestId: response.requestId,
    httpStatus: response.status,
  };
  const as = (normalised: SocialErrorCode, retryable?: boolean) =>
    new SocialProviderError(normalised, detail, { ...options, retryable });
  const status = response.status;

  if (
    body.error === 'invalid_grant' ||
    (body.error === 'invalid_request' && DEAD_GRANT.test(message))
  )
    return as('AUTH_EXPIRED');
  if (
    status === 401 ||
    (code && TOKEN_CODES.has(code)) ||
    (body.serviceErrorCode !== undefined &&
      TOKEN_SERVICE_CODES.has(body.serviceErrorCode))
  )
    return as('AUTH_EXPIRED');
  if (status === 429 || code === 'TOO_MANY_REQUESTS') return as('RATE_LIMITED');
  if (code && NOT_READY_CODES.has(code)) return as('PROVIDER_PROCESSING', true);
  if (code && MEDIA_CODES.has(code)) return as('INVALID_MEDIA');
  if (code === 'DUPLICATE_POST' || /duplicate/i.test(message))
    return as('UNSUPPORTED_CONTENT');
  if (
    status === 403 ||
    code === 'ACCESS_DENIED' ||
    body.serviceErrorCode === 100
  )
    return as('PERMISSION_DENIED');
  if (status === 409 || status >= 500)
    // Write conflicts and server errors: on the decisive call the post may exist.
    return new SocialProviderError('PROVIDER_UNAVAILABLE', detail, {
      ...options,
      retryable: !request.decisive,
      outcome: request.decisive ? 'unknown' : 'not_published',
    });
  return classifyHttp(response, request, detail);
}
