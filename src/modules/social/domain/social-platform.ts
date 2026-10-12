export const SocialPlatform = {
  FACEBOOK: 'facebook',
  INSTAGRAM: 'instagram',
  TIKTOK: 'tiktok',
  YOUTUBE: 'youtube',
  X: 'x',
  LINKEDIN: 'linkedin',
} as const;
export type SocialPlatform =
  (typeof SocialPlatform)[keyof typeof SocialPlatform];
export const SOCIAL_PLATFORMS = Object.values(SocialPlatform) as [
  SocialPlatform,
  ...SocialPlatform[],
];

/** The OAuth/API provider behind a platform (Meta serves both Facebook Pages and Instagram). */
export const SOCIAL_PROVIDERS = [
  'meta',
  'tiktok',
  'youtube',
  'x',
  'linkedin',
] as const;
export type SocialProviderId = (typeof SOCIAL_PROVIDERS)[number];

export const PROVIDER_FOR_PLATFORM: Record<SocialPlatform, SocialProviderId> = {
  facebook: 'meta',
  instagram: 'meta',
  tiktok: 'tiktok',
  youtube: 'youtube',
  x: 'x',
  linkedin: 'linkedin',
};

export const PLATFORMS_FOR_PROVIDER: Record<
  SocialProviderId,
  readonly SocialPlatform[]
> = {
  meta: ['facebook', 'instagram'],
  tiktok: ['tiktok'],
  youtube: ['youtube'],
  x: ['x'],
  linkedin: ['linkedin'],
};

export const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  x: 'X',
  linkedin: 'LinkedIn',
};

export const isSocialPlatform = (value: string): value is SocialPlatform =>
  (SOCIAL_PLATFORMS as readonly string[]).includes(value);

export const isSocialProvider = (value: string): value is SocialProviderId =>
  (SOCIAL_PROVIDERS as readonly string[]).includes(value);
