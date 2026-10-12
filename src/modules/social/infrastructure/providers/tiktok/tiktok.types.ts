import type { TIKTOK_PRIVACY_LEVELS } from '../../../domain/target-settings.js';

export interface TikTokConfig {
  clientKey?: string;
  clientSecret?: string;
  timeoutMs: number;
  /** false until TikTok audits the app: all posts forced to SELF_ONLY */
  audited: boolean;
}

export type TikTokPrivacyLevel = (typeof TIKTOK_PRIVACY_LEVELS)[number];

/**
 * Every Content Posting / Display API v2 response carries an `error` object, with `code: 'ok'`
 * on success, next to its `data`.
 */
export interface TikTokEnvelope<T> {
  data?: T;
  error?: TikTokApiErrorBody;
}

export interface TikTokApiErrorBody {
  code?: string;
  message?: string;
  log_id?: string;
}

/** OAuth endpoints answer in RFC 6749 style, often with HTTP 200 even for errors. */
export interface TikTokOAuthErrorBody {
  error?: string;
  error_description?: string;
  log_id?: string;
}

export interface TikTokTokenResponse {
  access_token: string;
  /** Seconds (about 24 h). */
  expires_in: number;
  open_id: string;
  refresh_token: string;
  /** Seconds (about 365 days). The refresh token may rotate on every refresh. */
  refresh_expires_in?: number;
  /** Comma-separated scopes the user granted. */
  scope: string;
  token_type?: string;
}

export interface TikTokUser {
  open_id: string;
  union_id?: string;
  avatar_url?: string;
  display_name?: string;
}

export interface TikTokCreatorInfo {
  creator_avatar_url?: string;
  creator_username?: string;
  creator_nickname?: string;
  privacy_level_options?: string[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
}

export type TikTokPublishStatus =
  | 'PROCESSING_UPLOAD'
  | 'PROCESSING_DOWNLOAD'
  | 'SEND_TO_USER_INBOX'
  | 'PUBLISH_COMPLETE'
  | 'FAILED';

export interface TikTokPublishStatusData {
  status?: TikTokPublishStatus;
  fail_reason?: string;
  /** Sic: TikTok's spelling. Only filled for posts that became public. */
  publicaly_available_post_id?: Array<number | string>;
  uploaded_bytes?: number;
  downloaded_bytes?: number;
}
