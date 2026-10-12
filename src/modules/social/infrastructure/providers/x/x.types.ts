export interface XConfig {
  clientId?: string;
  clientSecret?: string;
  timeoutMs: number;
}

/** OAuth 2.0 token endpoint response (authorization_code and refresh_token grants). */
export interface XTokenResponse {
  token_type: string;
  access_token: string;
  /** Present when `offline.access` was granted; rotates on every refresh. */
  refresh_token?: string;
  expires_in?: number;
  /** Space-separated granted scopes. */
  scope?: string;
}

/** RFC 6749 error body returned by the token and revoke endpoints. */
export interface XOAuthError {
  error?: string;
  error_description?: string;
}

/**
 * X API v2 failure body: problem+json (`title`, `detail`, `type`, `status`) and/or an `errors`
 * array (v2 partial errors, or v1.1-style `{ message, code }` from the media endpoints).
 */
export interface XProblem extends XOAuthError {
  title?: string;
  detail?: string;
  type?: string;
  status?: number;
  errors?: Array<{
    message?: string;
    code?: number;
    title?: string;
    detail?: string;
    type?: string;
  }>;
}

export interface XUser {
  id: string;
  name?: string;
  username: string;
  profile_image_url?: string;
}

export type XProcessingState =
  'pending' | 'in_progress' | 'succeeded' | 'failed';

export interface XProcessingInfo {
  state: XProcessingState;
  check_after_secs?: number;
  progress_percent?: number;
  error?: { code?: number; name?: string; message?: string };
}

/** Response of upload, initialize, finalize and status calls. */
export interface XMediaResponse {
  data: {
    id: string;
    media_key?: string;
    size?: number;
    expires_after_secs?: number;
    processing_info?: XProcessingInfo;
  };
}

export interface XTweetCreateResponse {
  data: { id: string; text?: string };
}

export interface XTweetMetricsResponse {
  data?: {
    id: string;
    public_metrics?: {
      retweet_count?: number;
      reply_count?: number;
      like_count?: number;
      quote_count?: number;
      bookmark_count?: number;
      impression_count?: number;
    };
  };
}
