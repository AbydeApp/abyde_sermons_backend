export interface MetaConfig {
  appId?: string;
  appSecret?: string;
  /** Graph API version, e.g. `v21.0`; configuration, never hard-coded at call sites. */
  graphVersion: string;
  timeoutMs: number;
}

export interface GraphError {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    is_transient?: boolean;
    fbtrace_id?: string;
  };
}

export interface MetaPage {
  id: string;
  name: string;
  access_token?: string;
  tasks?: string[];
  picture?: { data?: { url?: string } };
  instagram_business_account?: {
    id: string;
    username?: string;
    name?: string;
    profile_picture_url?: string;
  };
}

export type InstagramContainerStatus =
  'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED';
