import { validationError } from '../../../shared/domain/domain-error.js';
// Type-only: brand-profile imports this module, so a value import would be circular.
import type { WatermarkPosition } from './brand-profile.js';

export const HOOK_STYLES = [
  'IMPACT',
  'QUESTION',
  'MINIMAL',
  'HIGHLIGHT',
  'TYPEWRITER',
] as const;
export type HookStyle = (typeof HOOK_STYLES)[number];

export const CAPTION_STYLES = [
  'CLEAN',
  'WORD_HIGHLIGHT',
  'POP',
  'DYNAMIC',
] as const;
export type CaptionStyle = (typeof CAPTION_STYLES)[number];

/** CLEAN is static text; every other style animates word by word. */
export const isAnimatedCaptionStyle = (style: CaptionStyle): boolean =>
  style !== 'CLEAN';

export const CAPTION_POSITIONS = ['top', 'middle', 'bottom'] as const;
export type CaptionPosition = (typeof CAPTION_POSITIONS)[number];

export const LOGO_POSITIONS = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'none',
] as const satisfies ReadonlyArray<WatermarkPosition | 'none'>;
export type LogoPosition = (typeof LOGO_POSITIONS)[number];

/** How the church's Reels look by default; each Reel can override hook and caption choices. */
export interface VideoSettings {
  hookStyle: HookStyle;
  captionStyle: CaptionStyle;
  captionPosition: CaptionPosition;
  logoPosition: LogoPosition;
  showSpeakerName: boolean;
  showChurchName: boolean;
  /** A short branded end card (logo, church name, handle) after the sermon moment. */
  outroEnabled: boolean;
}

export const DEFAULT_VIDEO_SETTINGS: VideoSettings = {
  hookStyle: 'IMPACT',
  captionStyle: 'WORD_HIGHLIGHT',
  captionPosition: 'bottom',
  logoPosition: 'top-right',
  showSpeakerName: true,
  showChurchName: true,
  outroEnabled: true,
};

const oneOf = <T extends string>(
  allowed: readonly T[],
  value: unknown,
): value is T => typeof value === 'string' && allowed.includes(value as T);

/**
 * Reads stored settings leniently: unknown or missing values fall back to defaults, so adding a
 * setting later never breaks profiles saved before it existed.
 */
export function normalizeVideoSettings(raw: unknown): VideoSettings {
  const value = (raw ?? {}) as Partial<Record<keyof VideoSettings, unknown>>;
  const bool = (key: keyof VideoSettings, fallback: boolean) =>
    typeof value[key] === 'boolean' ? (value[key] as boolean) : fallback;
  const d = DEFAULT_VIDEO_SETTINGS;
  return {
    hookStyle: oneOf(HOOK_STYLES, value.hookStyle)
      ? value.hookStyle
      : d.hookStyle,
    captionStyle: oneOf(CAPTION_STYLES, value.captionStyle)
      ? value.captionStyle
      : d.captionStyle,
    captionPosition: oneOf(CAPTION_POSITIONS, value.captionPosition)
      ? value.captionPosition
      : d.captionPosition,
    logoPosition: oneOf(LOGO_POSITIONS, value.logoPosition)
      ? value.logoPosition
      : d.logoPosition,
    showSpeakerName: bool('showSpeakerName', d.showSpeakerName),
    showChurchName: bool('showChurchName', d.showChurchName),
    outroEnabled: bool('outroEnabled', d.outroEnabled),
  };
}

/** Applies a partial update strictly: unknown values are rejected rather than ignored. */
export function mergeVideoSettings(
  current: VideoSettings,
  patch: Partial<VideoSettings>,
): VideoSettings {
  const checks: Array<[keyof VideoSettings, readonly string[]]> = [
    ['hookStyle', HOOK_STYLES],
    ['captionStyle', CAPTION_STYLES],
    ['captionPosition', CAPTION_POSITIONS],
    ['logoPosition', LOGO_POSITIONS],
  ];
  for (const [key, allowed] of checks) {
    const value = patch[key];
    if (value !== undefined && !oneOf(allowed, value))
      throw validationError(`videoSettings.${key}`, `Unknown ${key}`);
  }
  return { ...current, ...patch };
}
