import type {
  SocialHttpRequest,
  SocialHttpResponse,
} from '../shared/social-http.client.js';
import { classifyHttp } from '../shared/social-http.client.js';
import {
  type SocialErrorCode,
  SocialProviderError,
} from '../../../helper.js';
import type { GraphError } from './meta.types.js';

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
/** Instagram media problems (format, size, aspect ratio, duration…). */
const IG_MEDIA_SUBCODES = new Set([
  2207001, 2207003, 2207004, 2207005, 2207006, 2207008, 2207009, 2207010,
  2207023, 2207026, 2207052,
]);
/** Container or upload not finished yet. */
const NOT_READY = { codes: new Set([9007]), subcodes: new Set([2207027]) };

/** Graph API error object → normalised social error. Falls back to HTTP status rules. */
export function mapGraphError(
  response: SocialHttpResponse,
  request: SocialHttpRequest,
): SocialProviderError {
  const error = (response.json as GraphError | null)?.error;
  const code = error?.code;
  const subcode = error?.error_subcode;
  const detail =
    `${request.operation}: ${response.status} ${error?.type ?? ''} #${code ?? '?'}/${subcode ?? '-'} ${error?.message ?? ''}`.trim();
  const options = {
    providerRequestId: error?.fbtrace_id ?? response.requestId,
    httpStatus: response.status,
  };
  const as = (normalised: SocialErrorCode, retryable?: boolean) =>
    new SocialProviderError(normalised, detail, { ...options, retryable });

  if (code === undefined) return classifyHttp(response, request, detail);
  if (code === 190 || code === 102 || code === 463 || code === 467)
    return as('AUTH_EXPIRED');
  if (code === 10 || code === 3 || code === 368 || (code >= 200 && code <= 299))
    return as('PERMISSION_DENIED');
  if (
    RATE_LIMIT_CODES.has(code) ||
    (code >= 80001 && code <= 80014) ||
    subcode === 2207042 // Instagram content publishing limit
  )
    return as('RATE_LIMITED');
  if (NOT_READY.codes.has(code) || (subcode && NOT_READY.subcodes.has(subcode)))
    return as('PROVIDER_PROCESSING', true);
  if (
    (subcode && IG_MEDIA_SUBCODES.has(subcode)) ||
    code === 352 ||
    code === 1363030
  )
    return as('INVALID_MEDIA');
  if (code === 1 || code === 2 || error?.is_transient)
    return response.status >= 500 && request.decisive
      ? new SocialProviderError('PROVIDER_UNAVAILABLE', detail, {
          ...options,
          outcome: 'unknown',
        })
      : as('PROVIDER_UNAVAILABLE', !request.decisive);
  if (code === 100) return as('UNSUPPORTED_CONTENT');
  return classifyHttp(response, request, detail);
}
