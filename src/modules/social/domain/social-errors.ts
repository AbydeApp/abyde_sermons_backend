export const SocialErrorCode = {
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_MEDIA: 'INVALID_MEDIA',
  UNSUPPORTED_CONTENT: 'UNSUPPORTED_CONTENT',
  PROVIDER_PROCESSING: 'PROVIDER_PROCESSING',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  UNKNOWN: 'UNKNOWN',
} as const;
export type SocialErrorCode =
  (typeof SocialErrorCode)[keyof typeof SocialErrorCode];

/**
 * Whether the provider may have published anything.
 * - `not_published`: the provider certainly did not publish (rejected, or the decisive call was never sent).
 * - `unknown`: the decisive call was sent but no answer was read (timeout, 5xx). Never retried
 *   automatically, because a duplicate public post is worse than a visible failure.
 */
export type PublishOutcomeCertainty = 'not_published' | 'unknown';

/**
 * Normalised provider failure. `message` is a diagnostic for secure logs only (never tokens);
 * clients see `SAFE_MESSAGES[code]`.
 */
export class SocialProviderError extends Error {
  readonly retryable: boolean;
  readonly outcome: PublishOutcomeCertainty;
  readonly providerRequestId?: string;
  readonly httpStatus?: number;

  constructor(
    readonly code: SocialErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      outcome?: PublishOutcomeCertainty;
      providerRequestId?: string;
      httpStatus?: number;
    } = {},
  ) {
    super(message);
    this.name = 'SocialProviderError';
    this.outcome = options.outcome ?? 'not_published';
    // An unknown outcome is never retryable, whatever the caller said.
    this.retryable =
      this.outcome === 'not_published' &&
      (options.retryable ?? DEFAULT_RETRYABLE[code]);
    this.providerRequestId = options.providerRequestId;
    this.httpStatus = options.httpStatus;
  }
}

const DEFAULT_RETRYABLE: Record<SocialErrorCode, boolean> = {
  AUTH_EXPIRED: false,
  PERMISSION_DENIED: false,
  RATE_LIMITED: true,
  INVALID_MEDIA: false,
  UNSUPPORTED_CONTENT: false,
  PROVIDER_PROCESSING: true,
  PROVIDER_UNAVAILABLE: true,
  UNKNOWN: false,
};

/** Actionable text for the frontend. Provider diagnostics stay in logs. */
export const SAFE_MESSAGES: Record<SocialErrorCode, string> = {
  AUTH_EXPIRED:
    'The connection to this account has expired. Reconnect it and try again.',
  PERMISSION_DENIED:
    'This account did not grant permission to publish. Reconnect it and approve every requested permission.',
  RATE_LIMITED: 'The platform is limiting requests right now. Try again later.',
  INVALID_MEDIA:
    'The platform rejected the media. Check its format, size and length.',
  UNSUPPORTED_CONTENT: 'This platform does not support this kind of post.',
  PROVIDER_PROCESSING: 'The platform is still processing the media.',
  PROVIDER_UNAVAILABLE:
    'The platform is temporarily unavailable. Try again shortly.',
  UNKNOWN: 'Something went wrong while publishing.',
};

export const OUTCOME_UNKNOWN_MESSAGE =
  "We couldn't confirm whether this was posted. Check the account before retrying.";

export const asSocialProviderError = (
  error: unknown,
  decisiveCallMade: boolean,
): SocialProviderError =>
  error instanceof SocialProviderError
    ? error
    : new SocialProviderError(
        'UNKNOWN',
        `Unexpected adapter error: ${(error as Error)?.message ?? String(error)}`,
        {
          outcome: decisiveCallMade ? 'unknown' : 'not_published',
          retryable: false,
        },
      );
