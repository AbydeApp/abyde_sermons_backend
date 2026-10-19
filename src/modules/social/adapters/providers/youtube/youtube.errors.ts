import {
  type SocialErrorCode,
  SocialProviderError,
} from '../../../helper.js';
import type {
  SocialHttpRequest,
  SocialHttpResponse,
} from '../shared/social-http.client.js';
import { classifyHttp } from '../shared/social-http.client.js';
import type { GoogleErrorResponse } from './youtube.types.js';

/** `errors[].reason` values of the YouTube Data API, grouped by what the user can do about them. */
const AUTH_REASONS = new Set([
  'authError',
  'unauthorized',
  'invalidCredentials',
]);
const PERMISSION_REASONS = new Set([
  'insufficientPermissions',
  'forbidden',
  'youtubeSignupRequired',
  'channelClosed',
  'channelSuspended',
]);
/** `quotaExceeded` resets daily (midnight Pacific); it is still a rate limit to the caller. */
const RATE_REASONS = new Set([
  'quotaExceeded',
  'dailyLimitExceeded',
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'uploadLimitExceeded',
]);
const MEDIA_REASONS = new Set([
  'mediaBodyRequired',
  'invalidImage',
  'imageTooLarge',
  'invalidFilename',
  'uploadTooLarge',
]);
const CONTENT_REASONS = new Set([
  'invalidTitle',
  'invalidDescription',
  'invalidTags',
  'invalidCategoryId',
  'invalidVideoMetadata',
  'invalidRecordingDetails',
  'invalidPublishAt',
]);

/** OAuth endpoint `error` values (RFC 6749 §5.2). */
const OAUTH_AUTH_ERRORS = new Set(['invalid_grant', 'invalid_token']);
const OAUTH_PERMISSION_ERRORS = new Set([
  'access_denied',
  'unauthorized_client',
  'invalid_scope',
]);

/** Google error body (Data API or OAuth shape) → normalised social error; HTTP status as fallback. */
export function mapGoogleError(
  response: SocialHttpResponse,
  request: SocialHttpRequest,
): SocialProviderError {
  const body = response.json as GoogleErrorResponse | null;
  const error = body?.error;
  const options = {
    providerRequestId: response.requestId,
    httpStatus: response.status,
  };

  if (typeof error === 'string') {
    // Token endpoint. The description never echoes the token, but keep it short anyway.
    const detail =
      `${request.operation}: ${response.status} ${error} ${body?.error_description?.slice(0, 200) ?? ''}`.trim();
    if (OAUTH_AUTH_ERRORS.has(error))
      return new SocialProviderError('AUTH_EXPIRED', detail, options);
    if (OAUTH_PERMISSION_ERRORS.has(error))
      return new SocialProviderError('PERMISSION_DENIED', detail, options);
    if (error === 'invalid_client')
      // Our client credentials are wrong: an operator problem, not something a retry fixes.
      return new SocialProviderError('UNKNOWN', detail, options);
    return classifyHttp(response, request, detail);
  }

  const reason = error?.errors?.find((entry) => entry.reason)?.reason;
  const detail =
    `${request.operation}: ${response.status} ${reason ?? error?.status ?? ''} ${error?.message?.slice(0, 300) ?? ''}`.trim();
  const as = (code: SocialErrorCode) =>
    new SocialProviderError(code, detail, options);

  // Provider-side failures keep the decisive/unknown rule of `classifyHttp`, whatever the reason.
  if (response.status >= 500 || !reason)
    return classifyHttp(response, request, detail);
  if (AUTH_REASONS.has(reason)) return as('AUTH_EXPIRED');
  if (RATE_REASONS.has(reason)) return as('RATE_LIMITED');
  if (PERMISSION_REASONS.has(reason)) return as('PERMISSION_DENIED');
  if (MEDIA_REASONS.has(reason)) return as('INVALID_MEDIA');
  if (CONTENT_REASONS.has(reason)) return as('UNSUPPORTED_CONTENT');
  // The YouTube Data API is not enabled on our Google Cloud project: reconnecting will not help.
  if (reason === 'accessNotConfigured') return as('UNKNOWN');
  return classifyHttp(response, request, detail);
}

/** A 404 from a video endpoint: the video is already gone (delete is then a no-op). */
export const isVideoNotFound = (error: unknown): boolean =>
  error instanceof SocialProviderError && error.httpStatus === 404;
