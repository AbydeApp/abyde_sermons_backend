import { validationError } from '../../../shared/domain/domain-error.js';
import {
  CONTENT_TYPES,
  type ContentType,
} from '../../content/domain/content-types.js';
import {
  DEFAULT_VIDEO_SETTINGS,
  mergeVideoSettings,
  type VideoSettings,
} from './video-settings.js';

export const EMOJI_USAGE = [
  'none',
  'rarely',
  'occasionally',
  'frequently',
] as const;
export type EmojiUsage = (typeof EMOJI_USAGE)[number];

export const WATERMARK_POSITIONS = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
] as const;
export type WatermarkPosition = (typeof WATERMARK_POSITIONS)[number];

export interface PreferredTerm {
  preferred: string;
  insteadOf?: string;
}

export interface BrandVoice {
  tone: string;
  bibleTranslation?: string;
  emojiUsage: EmojiUsage;
  writingStyle?: string;
  preferredTerms: PreferredTerm[];
  avoidPhrases: string[];
  ctaStyle?: string;
  hashtagPreferences: string[];
}

export interface BrandProfile {
  id: string;
  churchId: string;
  churchName: string;
  logoAssetId?: string;
  alternateLogoAssetId?: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  headingFont: string;
  bodyFont: string;
  socialHandle?: string;
  website?: string;
  watermarkEnabled: boolean;
  watermarkPosition?: WatermarkPosition;
  voice: BrandVoice;
  /** Template chosen per content type; anything absent uses the catalog default. */
  templateDefaults: Partial<Record<ContentType, string>>;
  /** Reel look: hook and caption styles, logo, labels, outro. */
  videoSettings: VideoSettings;
}

/** `null` clears an optional field; `undefined` leaves it unchanged. */
export interface BrandProfilePatch {
  churchName?: string;
  logoAssetId?: string | null;
  alternateLogoAssetId?: string | null;
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
  headingFont?: string;
  bodyFont?: string;
  socialHandle?: string | null;
  website?: string | null;
  watermarkEnabled?: boolean;
  watermarkPosition?: WatermarkPosition | null;
  voice?: Partial<BrandVoice>;
  videoSettings?: Partial<VideoSettings>;
}

export const DEFAULT_COLORS = {
  primary: '#1F2A44',
  secondary: '#3B5BA5',
  accent: '#F2B441',
} as const;
export const DEFAULT_FONT = 'Inter';

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
/** Font family names end up inside SVG/ASS attributes, so the alphabet is deliberately small. */
const FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9 -]{0,59}$/;
const HANDLE = /^@?[A-Za-z0-9._]{1,50}$/;

const LIMITS = {
  churchName: 120,
  website: 255,
  tone: 200,
  bibleTranslation: 20,
  writingStyle: 500,
  ctaStyle: 200,
  term: 80,
  terms: 50,
  phrases: 50,
  hashtags: 30,
} as const;

export function defaultBrandVoice(bibleTranslation?: string): BrandVoice {
  return {
    tone: '',
    bibleTranslation,
    emojiUsage: 'rarely',
    preferredTerms: [],
    avoidPhrases: [],
    hashtagPreferences: [],
  };
}

/** Profile shown before a church has saved anything, seeded from what the church already told us. */
export function defaultBrandProfile(seed: {
  id: string;
  churchId: string;
  churchName: string;
  primaryColor?: string | null;
  secondaryColor?: string | null;
  bibleTranslation?: string | null;
  website?: string | null;
}): BrandProfile {
  return {
    id: seed.id,
    churchId: seed.churchId,
    churchName: seed.churchName,
    primaryColor: seed.primaryColor ?? DEFAULT_COLORS.primary,
    secondaryColor: seed.secondaryColor ?? DEFAULT_COLORS.secondary,
    accentColor: DEFAULT_COLORS.accent,
    headingFont: DEFAULT_FONT,
    bodyFont: DEFAULT_FONT,
    website: seed.website ?? undefined,
    watermarkEnabled: false,
    voice: defaultBrandVoice(seed.bibleTranslation ?? undefined),
    templateDefaults: {},
    videoSettings: { ...DEFAULT_VIDEO_SETTINGS },
  };
}

const text = (
  field: string,
  value: string,
  max: number,
  required = false,
): string => {
  const trimmed = value.trim();
  if (required && !trimmed) throw validationError(field, 'This is required');
  if (trimmed.length > max)
    throw validationError(field, `Must be at most ${max} characters`);
  return trimmed;
};

const optionalText = (
  field: string,
  value: string | null | undefined,
  max: number,
): string | undefined => {
  if (value === null || value === undefined) return undefined;
  return text(field, value, max) || undefined;
};

const color = (field: string, value: string): string => {
  if (!HEX_COLOR.test(value))
    throw validationError(field, 'Use a #RRGGBB colour');
  return value.toUpperCase();
};

const font = (field: string, value: string): string => {
  const trimmed = value.trim();
  if (!FONT_NAME.test(trimmed))
    throw validationError(
      field,
      'Use a font name made of letters, numbers, spaces or hyphens',
    );
  return trimmed;
};

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

const list = (field: string, values: string[], max: number): string[] => {
  if (values.length > max)
    throw validationError(field, `At most ${max} entries`);
  return [
    ...new Set(
      values.map((value) => text(field, value, LIMITS.term)).filter(Boolean),
    ),
  ];
};

function mergeVoice(
  current: BrandVoice,
  patch: Partial<BrandVoice>,
): BrandVoice {
  const next = { ...current, ...patch };
  if (!EMOJI_USAGE.includes(next.emojiUsage))
    throw validationError('voice.emojiUsage', 'Unknown emoji usage');
  if (next.preferredTerms.length > LIMITS.terms)
    throw validationError(
      'voice.preferredTerms',
      `At most ${LIMITS.terms} entries`,
    );
  return {
    tone: text('voice.tone', next.tone, LIMITS.tone),
    bibleTranslation: optionalText(
      'voice.bibleTranslation',
      next.bibleTranslation,
      LIMITS.bibleTranslation,
    ),
    emojiUsage: next.emojiUsage,
    writingStyle: optionalText(
      'voice.writingStyle',
      next.writingStyle,
      LIMITS.writingStyle,
    ),
    preferredTerms: next.preferredTerms
      .map((term) => ({
        preferred: text('voice.preferredTerms', term.preferred, LIMITS.term),
        insteadOf: optionalText(
          'voice.preferredTerms',
          term.insteadOf,
          LIMITS.term,
        ),
      }))
      .filter((term) => term.preferred),
    avoidPhrases: list('voice.avoidPhrases', next.avoidPhrases, LIMITS.phrases),
    ctaStyle: optionalText('voice.ctaStyle', next.ctaStyle, LIMITS.ctaStyle),
    hashtagPreferences: list(
      'voice.hashtagPreferences',
      next.hashtagPreferences,
      LIMITS.hashtags,
    ).map((tag) => (tag.startsWith('#') ? tag : `#${tag}`)),
  };
}

/** Applies a patch and enforces every invariant of the profile. Returns a new object. */
export function applyBrandPatch(
  current: BrandProfile,
  patch: BrandProfilePatch,
): BrandProfile {
  const pick = <T>(value: T | null | undefined, fallback: T | undefined) =>
    value === undefined ? fallback : (value ?? undefined);
  const socialHandle = pick(patch.socialHandle, current.socialHandle)?.trim();
  if (socialHandle && !HANDLE.test(socialHandle))
    throw validationError(
      'socialHandle',
      'Use letters, numbers, dots or underscores',
    );
  const website = optionalText(
    'website',
    pick(patch.website, current.website),
    LIMITS.website,
  );
  if (website && !isHttpUrl(website))
    throw validationError('website', 'Enter a valid http(s) URL');
  const watermarkPosition = pick(
    patch.watermarkPosition,
    current.watermarkPosition,
  );
  if (watermarkPosition && !WATERMARK_POSITIONS.includes(watermarkPosition))
    throw validationError('watermarkPosition', 'Unknown watermark position');
  return {
    id: current.id,
    churchId: current.churchId,
    churchName: text(
      'churchName',
      patch.churchName ?? current.churchName,
      LIMITS.churchName,
      true,
    ),
    logoAssetId: pick(patch.logoAssetId, current.logoAssetId),
    alternateLogoAssetId: pick(
      patch.alternateLogoAssetId,
      current.alternateLogoAssetId,
    ),
    primaryColor: color(
      'primaryColor',
      patch.primaryColor ?? current.primaryColor,
    ),
    secondaryColor: color(
      'secondaryColor',
      patch.secondaryColor ?? current.secondaryColor,
    ),
    accentColor: color('accentColor', patch.accentColor ?? current.accentColor),
    headingFont: font('headingFont', patch.headingFont ?? current.headingFont),
    bodyFont: font('bodyFont', patch.bodyFont ?? current.bodyFont),
    socialHandle: socialHandle
      ? `@${socialHandle.replace(/^@/, '')}`
      : undefined,
    website,
    watermarkEnabled: patch.watermarkEnabled ?? current.watermarkEnabled,
    watermarkPosition,
    voice: patch.voice ? mergeVoice(current.voice, patch.voice) : current.voice,
    templateDefaults: current.templateDefaults,
    videoSettings: patch.videoSettings
      ? mergeVideoSettings(current.videoSettings, patch.videoSettings)
      : current.videoSettings,
  };
}

export const isContentType = (value: string): value is ContentType =>
  (CONTENT_TYPES as readonly string[]).includes(value);

/** What the renderer needs from the brand, captured when a render is requested. */
export interface BrandSnapshot {
  churchName: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  headingFont: string;
  bodyFont: string;
  socialHandle?: string;
  website?: string;
  /** Storage key of the logo to stamp, when the watermark is enabled and a logo exists. */
  logoObjectKey?: string;
  watermarkPosition: WatermarkPosition;
}
