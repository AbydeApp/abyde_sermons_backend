import { validationError } from '../../../shared/domain/domain-error.js';
import type { SocialPlatform } from './social-platform.js';

export const TIKTOK_PRIVACY_LEVELS = [
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
] as const;
export const YOUTUBE_PRIVACY = ['public', 'unlisted', 'private'] as const;
export const LINKEDIN_VISIBILITY = ['PUBLIC', 'CONNECTIONS'] as const;

/**
 * Per-platform choices a user makes for one target. Some are required by platform policy rather
 * than by us (TikTok wants an explicit privacy choice, YouTube an explicit made-for-kids answer).
 */
export function validateTargetSettings(
  platform: SocialPlatform,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const field = (name: string) => `targets.${platform}.settings.${name}`;
  switch (platform) {
    case 'tiktok':
      if (!TIKTOK_PRIVACY_LEVELS.includes(settings.privacyLevel as never))
        throw validationError(
          field('privacyLevel'),
          'Choose who can see this TikTok',
        );
      return {
        privacyLevel: settings.privacyLevel,
        disableComment: settings.disableComment === true,
        disableDuet: settings.disableDuet === true,
        disableStitch: settings.disableStitch === true,
      };
    case 'youtube':
      if (!YOUTUBE_PRIVACY.includes(settings.privacyStatus as never))
        throw validationError(
          field('privacyStatus'),
          'Choose public, unlisted or private',
        );
      if (typeof settings.madeForKids !== 'boolean')
        throw validationError(
          field('madeForKids'),
          'Say whether this video is made for kids',
        );
      return {
        privacyStatus: settings.privacyStatus,
        madeForKids: settings.madeForKids,
        tags: Array.isArray(settings.tags)
          ? settings.tags
              .filter((tag): tag is string => typeof tag === 'string')
              .map((tag) => tag.trim())
              .filter(Boolean)
              .slice(0, 30)
          : [],
      };
    case 'linkedin':
      return {
        visibility: LINKEDIN_VISIBILITY.includes(settings.visibility as never)
          ? settings.visibility
          : 'PUBLIC',
      };
    case 'instagram':
      return { shareToFeed: settings.shareToFeed !== false };
    case 'facebook':
      return { asReel: settings.asReel === true };
    case 'x':
      return {};
  }
}
