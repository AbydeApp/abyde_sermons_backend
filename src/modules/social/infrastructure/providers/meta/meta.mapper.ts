import type { ConnectedAccount } from '../../../application/ports/out/social-publishing.port.js';
import type { PlatformCapabilities } from '../../../domain/capabilities.js';
import type { MetaPage } from './meta.types.js';

const MB = 1024 ** 2;
const GB = 1024 ** 3;

export function toFacebookAccount(
  page: MetaPage,
  scopes: string[],
): ConnectedAccount {
  return {
    platform: 'facebook',
    providerAccountId: page.id,
    accountName: page.name,
    avatarUrl: page.picture?.data?.url,
    accessToken: page.access_token ?? '',
    scopes,
    metadata: { pageId: page.id },
  };
}

export function toInstagramAccount(
  page: MetaPage,
  scopes: string[],
): ConnectedAccount {
  const instagram = page.instagram_business_account;
  if (!instagram) throw new Error('Page has no Instagram account');
  return {
    platform: 'instagram',
    providerAccountId: instagram.id,
    accountName: instagram.username
      ? `@${instagram.username}`
      : (instagram.name ?? page.name),
    avatarUrl: instagram.profile_picture_url,
    // Instagram Graph calls are made with the linked Page's token.
    accessToken: page.access_token ?? '',
    scopes,
    metadata: {
      pageId: page.id,
      igUserId: instagram.id,
      username: instagram.username ?? null,
    },
  };
}

export function metaCapabilities(configured: boolean): PlatformCapabilities[] {
  return [
    {
      platform: 'facebook',
      configured,
      textOnly: true,
      images: true,
      carousel: true,
      video: true,
      shortVideo: true,
      maxImages: 10,
      minCarouselImages: 2,
      maxCaptionLength: 63_206,
      titleRequired: false,
      maxTitleLength: 255,
      imageContentTypes: ['image/jpeg', 'image/png'],
      videoContentTypes: ['video/mp4'],
      maxImageBytes: 10 * MB,
      maxVideoBytes: 1 * GB,
      minVideoDurationSeconds: 3,
      maxVideoDurationSeconds: 20 * 60,
      restrictions: [
        'Publishes to Facebook Pages only, not personal profiles.',
      ],
    },
    {
      platform: 'instagram',
      configured,
      textOnly: false,
      images: true,
      carousel: true,
      video: true,
      shortVideo: true,
      maxImages: 10,
      minCarouselImages: 2,
      maxCaptionLength: 2_200,
      titleRequired: false,
      maxTitleLength: 0,
      imageContentTypes: ['image/jpeg'],
      videoContentTypes: ['video/mp4', 'video/quicktime'],
      maxImageBytes: 8 * MB,
      maxVideoBytes: 1 * GB,
      minVideoDurationSeconds: 3,
      maxVideoDurationSeconds: 15 * 60,
      restrictions: [
        'Needs an Instagram professional (Business or Creator) account linked to a Facebook Page.',
        'Videos are published as Reels.',
      ],
    },
  ];
}
