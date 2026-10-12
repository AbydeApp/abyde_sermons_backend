export interface YouTubeConfig {
  /** Google Cloud OAuth client (web application type). */
  clientId?: string;
  clientSecret?: string;
  /** Per attempt for ordinary API calls; upload chunks use their own, longer budget. */
  timeoutMs: number;
}

export interface YouTubeAdapterOptions {
  /**
   * Bytes per resumable-upload PUT. Must be a positive multiple of 256 KiB (Google rejects other
   * sizes for every chunk but the last). Tests lower it; production keeps the default.
   */
  chunkSizeBytes?: number;
}

/** Error body of the YouTube Data API and other googleapis.com JSON APIs. */
export interface GoogleApiErrorBody {
  code?: number;
  message?: string;
  status?: string;
  errors?: Array<{ reason?: string; domain?: string; message?: string }>;
}

/**
 * Google answers in two shapes: OAuth endpoints use `{ error: 'invalid_grant', error_description }`,
 * the Data API uses `{ error: { code, message, errors: [{ reason }] } }`.
 */
export interface GoogleErrorResponse {
  error?: string | GoogleApiErrorBody;
  error_description?: string;
}

export interface GoogleTokenResponse {
  access_token: string;
  /** Seconds; about one hour for Google access tokens. */
  expires_in?: number;
  /** Only on the first consent (prompt=consent forces it) or when Google decides to rotate it. */
  refresh_token?: string;
  /** Space separated granted scopes. */
  scope?: string;
  token_type?: string;
}

export interface YouTubeChannel {
  id: string;
  snippet?: {
    title?: string;
    customUrl?: string;
    thumbnails?: { default?: { url?: string } };
  };
}

export interface YouTubeVideo {
  id?: string;
  status?: {
    uploadStatus?: 'deleted' | 'failed' | 'processed' | 'rejected' | 'uploaded';
    failureReason?: string;
    rejectionReason?: string;
    privacyStatus?: string;
  };
  /** Counters arrive as decimal strings. */
  statistics?: {
    viewCount?: string;
    likeCount?: string;
    commentCount?: string;
  };
}

export interface YouTubeList<T> {
  items?: T[];
}

export type YouTubePrivacyStatus = 'public' | 'unlisted' | 'private';

/** Metadata sent when the resumable upload session is opened (`videos.insert`). */
export interface YouTubeVideoResource {
  snippet: {
    title: string;
    description: string;
    tags: string[];
    categoryId: string;
  };
  status: {
    privacyStatus: YouTubePrivacyStatus;
    selfDeclaredMadeForKids: boolean;
  };
}
