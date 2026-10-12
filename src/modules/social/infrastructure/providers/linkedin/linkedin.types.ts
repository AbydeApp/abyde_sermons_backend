export interface LinkedInConfig {
  clientId?: string;
  clientSecret?: string;
  timeoutMs: number;
  /** LinkedIn-Version header, YYYYMM */
  apiVersion: string;
  /** Community Management API approved: request org scopes and offer Pages */
  organizations: boolean;
}

/** Rest.li error body (`/rest/*`) or OAuth error body (`/oauth/v2/*`). */
export interface LinkedInErrorBody {
  status?: number;
  serviceErrorCode?: number;
  code?: string;
  message?: string;
  error?: string;
  error_description?: string;
}

export interface LinkedInTokenResponse {
  access_token: string;
  /** Seconds; 60 days for member tokens. */
  expires_in?: number;
  /** Granted scopes, comma- or space-separated. */
  scope?: string;
  /** Only for apps approved for programmatic refresh tokens. */
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

/** OpenID Connect userinfo (`/v2/userinfo`). */
export interface LinkedInUserInfo {
  sub: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
}

export interface LinkedInOrganizationAcl {
  role?: string;
  state?: string;
  roleAssignee?: string;
  /** Older versions return `organization`, newer ones `organizationTarget`. */
  organization?: string;
  organizationTarget?: string;
}

export interface LinkedInOrganization {
  id?: number;
  localizedName?: string;
  vanityName?: string;
}

export interface LinkedInImageUpload {
  value: { uploadUrl: string; image: string; uploadUrlExpiresAt?: number };
}

export interface LinkedInVideoUpload {
  value: {
    video: string;
    uploadToken?: string;
    uploadUrlsExpireAt?: number;
    uploadInstructions: Array<{
      uploadUrl: string;
      firstByte: number;
      lastByte: number;
    }>;
  };
}

export type LinkedInMediaStatus =
  'WAITING_UPLOAD' | 'PROCESSING' | 'AVAILABLE' | 'PROCESSING_FAILED';

export interface LinkedInVideo {
  id?: string;
  status?: LinkedInMediaStatus;
  processingFailureReason?: string;
}

export interface LinkedInSocialActions {
  likesSummary?: { totalLikes?: number };
  commentsSummary?: {
    aggregatedTotalComments?: number;
    totalFirstLevelComments?: number;
  };
}

export type LinkedInPostContent =
  | { media: { id: string; title?: string } }
  | { multiImage: { images: Array<{ id: string }> } };

export type LinkedInVisibility = 'PUBLIC' | 'CONNECTIONS' | 'LOGGED_IN';
