import type {
  SocialHttpRequest,
  SocialHttpResponse,
} from '../shared/social-http.client.js';
import { classifyHttp } from '../shared/social-http.client.js';
import {
  type PublishOutcomeCertainty,
  type SocialErrorCode,
  SocialProviderError,
} from '../../../domain/social-errors.js';
import type {
  TikTokApiErrorBody,
  TikTokOAuthErrorBody,
} from './tiktok.types.js';

/** A normalised error that keeps TikTok's own code, for the few callers that branch on it. */
export class TikTokApiError extends SocialProviderError {
  constructor(
    readonly tiktokCode: string,
    code: SocialErrorCode,
    message: string,
    options: ConstructorParameters<typeof SocialProviderError>[2] = {},
  ) {
    super(code, message, options);
  }
}

const URL_OWNERSHIP_HINT =
  'TikTok refused to pull the media URL: verify the media domain (URL prefix) for this app in the TikTok developer portal';

/** Content Posting API error codes (init, creator_info, status) → normalised code. */
const API_CODES: Record<string, SocialErrorCode> = {
  access_token_invalid: 'AUTH_EXPIRED',
  access_token_expired: 'AUTH_EXPIRED',
  token_expired: 'AUTH_EXPIRED',
  auth_removed: 'AUTH_EXPIRED',
  scope_not_authorized: 'PERMISSION_DENIED',
  scope_permission_missed: 'PERMISSION_DENIED',
  unaudited_client_can_only_post_to_private_accounts: 'PERMISSION_DENIED',
  url_ownership_unverified: 'PERMISSION_DENIED',
  spam_risk_user_banned_from_posting: 'PERMISSION_DENIED',
  spam_risk: 'PERMISSION_DENIED',
  spam_risk_text: 'PERMISSION_DENIED',
  rate_limit_exceeded: 'RATE_LIMITED',
  spam_risk_too_many_posts: 'RATE_LIMITED',
  spam_risk_too_many_pending_share: 'RATE_LIMITED',
  reached_active_user_cap: 'RATE_LIMITED',
  file_format_check_failed: 'INVALID_MEDIA',
  duration_check_failed: 'INVALID_MEDIA',
  frame_rate_check_failed: 'INVALID_MEDIA',
  picture_size_check_failed: 'INVALID_MEDIA',
  video_pull_failed: 'INVALID_MEDIA',
  photo_pull_failed: 'INVALID_MEDIA',
  invalid_file_upload: 'INVALID_MEDIA',
  invalid_param: 'UNSUPPORTED_CONTENT',
  invalid_params: 'UNSUPPORTED_CONTENT',
  privacy_level_option_mismatch: 'UNSUPPORTED_CONTENT',
  internal_error: 'PROVIDER_UNAVAILABLE',
  internal: 'PROVIDER_UNAVAILABLE',
};

/** Extra diagnostics for logs: the fix is on our side, not the user's. */
const HINTS: Record<string, string> = {
  url_ownership_unverified: URL_OWNERSHIP_HINT,
  unaudited_client_can_only_post_to_private_accounts:
    'App is not audited by TikTok: posts must be SELF_ONLY (check TIKTOK audited config and the creator account privacy)',
  video_pull_failed:
    'TikTok could not download the video: check the delivery URL is reachable, unexpired and on the verified domain',
  photo_pull_failed:
    'TikTok could not download a photo: check the delivery URL is reachable, unexpired and on the verified domain',
};

/** OAuth `error` strings (token, refresh, revoke) → normalised code. */
const OAUTH_CODES: Record<string, SocialErrorCode> = {
  invalid_grant: 'AUTH_EXPIRED',
  access_denied: 'PERMISSION_DENIED',
  // Our client key/secret or app setup is wrong: reconnecting will not help, ops must fix config.
  invalid_client: 'UNKNOWN',
  unauthorized_client: 'UNKNOWN',
  invalid_scope: 'UNKNOWN',
  rate_limit_exceeded: 'RATE_LIMITED',
  server_error: 'PROVIDER_UNAVAILABLE',
  temporarily_unavailable: 'PROVIDER_UNAVAILABLE',
};

/**
 * Builds the error for one TikTok code. Provider-side failures on the decisive call leave the
 * outcome unknown; anything TikTok explicitly refused was certainly not published.
 */
function tiktokError(
  tiktokCode: string,
  code: SocialErrorCode,
  detail: string,
  request: SocialHttpRequest,
  options: { providerRequestId?: string; httpStatus?: number },
): TikTokApiError {
  if (code === 'PROVIDER_UNAVAILABLE')
    return new TikTokApiError(tiktokCode, code, detail, {
      ...options,
      retryable: !request.decisive,
      outcome: request.decisive ? 'unknown' : 'not_published',
    });
  return new TikTokApiError(tiktokCode, code, detail, options);
}

/**
 * TikTok v2 error → normalised social error. Handles both shapes: the API envelope
 * (`{ error: { code, message, log_id } }`) and the OAuth one (`{ error, error_description }`).
 * Never echoes request parameters, so tokens and codes cannot reach the message.
 */
export function mapTikTokError(
  response: SocialHttpResponse,
  request: SocialHttpRequest,
): SocialProviderError {
  const body = response.json as
    (Omit<TikTokOAuthErrorBody, 'error'> & { error?: unknown }) | null;
  const raw = body?.error;
  const options = {
    providerRequestId: body?.log_id ?? response.requestId,
    httpStatus: response.status,
  };

  if (typeof raw === 'string') {
    const description = body?.error_description ?? '';
    const detail =
      `${request.operation}: ${response.status} ${raw} ${description}`.trim();
    if (response.status >= 500) return classifyHttp(response, request, detail);
    return tiktokError(
      raw,
      OAUTH_CODES[raw] ?? 'AUTH_EXPIRED',
      detail,
      request,
      options,
    );
  }

  const apiError = raw as TikTokApiErrorBody | undefined;
  const tiktokCode = apiError?.code;
  const detail = [
    `${request.operation}: ${response.status} ${tiktokCode ?? '?'} ${apiError?.message ?? ''}`.trim(),
    tiktokCode ? HINTS[tiktokCode] : undefined,
  ]
    .filter(Boolean)
    .join(' | ');
  const withLogId = {
    ...options,
    providerRequestId: apiError?.log_id ?? options.providerRequestId,
  };
  const mapped = tiktokCode ? API_CODES[tiktokCode] : undefined;
  if (!tiktokCode || tiktokCode === 'ok' || !mapped)
    return classifyHttp(response, request, detail);
  return tiktokError(tiktokCode, mapped, detail, request, withLogId);
}

/**
 * `fail_reason` of a FAILED publication. TikTok has definitively given up, so nothing was
 * published; pull failures and internal errors may succeed on a fresh attempt (new media URL).
 */
export function mapFailReason(
  failReason: string | undefined,
  publishId: string,
): TikTokApiError {
  const reason = failReason ?? 'unknown';
  const hint = HINTS[reason];
  const detail = `TikTok publication ${publishId} failed: ${reason}${hint ? ` | ${hint}` : ''}`;
  const outcome: PublishOutcomeCertainty = 'not_published';
  const as = (code: SocialErrorCode, retryable?: boolean) =>
    new TikTokApiError(reason, code, detail, { outcome, retryable });

  if (reason === 'video_pull_failed' || reason === 'photo_pull_failed')
    return as('INVALID_MEDIA', true);
  if (reason === 'internal' || reason === 'internal_error')
    return as('PROVIDER_UNAVAILABLE', true);
  if (reason === 'spam_risk_too_many_posts') return as('RATE_LIMITED');
  if (reason.startsWith('spam_risk')) return as('PERMISSION_DENIED');
  if (reason === 'publish_cancelled') return as('UNKNOWN');
  return as(API_CODES[reason] ?? 'UNKNOWN');
}
