import { z } from 'zod';
import { PermanentJobError } from '../../shared/application/jobs.js';
import { QUEUES } from '../../shared/application/ports/queue.port.js';
import { DomainError, validationError } from '../../shared/domain/domain-error.js';
import { CONTENT_TYPES, type ContentType } from '../content/helper.js';
import type { CardSpec } from './adapters/template-svg.js';

// ───────────────────────── Media assets ─────────────────────────

export const MEDIA_ASSET_KINDS = [
  'BRAND_LOGO',
  'IMAGE',
  'CAROUSEL_SLIDE',
  'VIDEO',
  'THUMBNAIL',
] as const;
export type MediaAssetKind = (typeof MEDIA_ASSET_KINDS)[number];
export type MediaAssetStatus = 'PENDING' | 'READY' | 'FAILED';

export interface MediaAsset {
  id: string;
  churchId: string;
  sermonId: string | null;
  contentItemId: string | null;
  kind: MediaAssetKind;
  status: MediaAssetStatus;
  objectKey: string;
  contentType: string;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** Assets produced by one render request share a group. */
  renderGroupId: string | null;
  position: number;
  /** What the worker renders; null for uploaded assets. */
  renderSpec: unknown;
  metadata: Record<string, unknown>;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MediaTechnicalMetadata {
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

const MB = 1024 ** 2;
export const BRAND_LOGO_MAX_BYTES = 5 * MB;

/** Raster formats only: SVG logos could carry script and are never accepted. */
const LOGO_TYPES: Record<string, string[]> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
};

export function validateLogoUpload(input: {
  fileName: string;
  contentType: string;
  sizeBytes: number;
}): { contentType: string; extension: string } {
  const contentType =
    input.contentType.toLowerCase().split(';')[0]?.trim() ?? '';
  const extensions = LOGO_TYPES[contentType];
  if (!extensions)
    throw validationError('contentType', 'Upload a PNG, JPEG or WebP image');
  const extension = input.fileName.toLowerCase().split('.').pop() ?? '';
  if (!extensions.includes(extension))
    throw validationError(
      'fileName',
      'The file extension does not match its type',
    );
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0)
    throw validationError('sizeBytes', 'File size is required');
  if (input.sizeBytes > BRAND_LOGO_MAX_BYTES)
    throw validationError('sizeBytes', 'File is too large (max 5 MB)');
  return { contentType, extension };
}

/** `churches/{churchId}/brand/{assetId}.{ext}` */
export const brandAssetKey = (
  churchId: string,
  assetId: string,
  extension: string,
): string => `churches/${churchId}/brand/${assetId}.${extension}`;

const GENERATED_FOLDERS: Record<
  Exclude<MediaAssetKind, 'BRAND_LOGO'>,
  string
> = {
  IMAGE: 'images',
  CAROUSEL_SLIDE: 'carousels',
  VIDEO: 'reels',
  THUMBNAIL: 'thumbnails',
};

/** `churches/{churchId}/sermons/{sermonId}/generated/{folder}/{assetId}.{ext}` */
export const generatedAssetKey = (
  churchId: string,
  sermonId: string,
  kind: Exclude<MediaAssetKind, 'BRAND_LOGO'>,
  assetId: string,
  extension: string,
): string =>
  `churches/${churchId}/sermons/${sermonId}/generated/${GENERATED_FOLDERS[kind]}/${assetId}.${extension}`;

// ───────────────────────── Brand profile ─────────────────────────

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
  footerText?: string;
  watermarkEnabled: boolean;
  watermarkPosition?: WatermarkPosition;
  voice: BrandVoice;
  /** Template chosen per content type; anything absent uses the catalog default. */
  templateDefaults: Partial<Record<ContentType, string>>;
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
  footerText?: string | null;
  watermarkEnabled?: boolean;
  watermarkPosition?: WatermarkPosition | null;
  voice?: Partial<BrandVoice>;
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
  footerText: 120,
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
    footerText: optionalText(
      'footerText',
      pick(patch.footerText, current.footerText),
      LIMITS.footerText,
    ),
    watermarkEnabled: patch.watermarkEnabled ?? current.watermarkEnabled,
    watermarkPosition,
    voice: patch.voice ? mergeVoice(current.voice, patch.voice) : current.voice,
    templateDefaults: current.templateDefaults,
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

// ───────────────────────── Templates ─────────────────────────

export const RENDER_FORMATS = ['image', 'carousel', 'video'] as const;
export type RenderFormat = (typeof RENDER_FORMATS)[number];

export const ASPECTS = {
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1350 },
  story: { width: 1080, height: 1920 },
} as const;
export type Aspect = keyof typeof ASPECTS;
export const ASPECT_NAMES = Object.keys(ASPECTS) as [Aspect, ...Aspect[]];

/** Short-form vertical video (Reel / Short / TikTok). */
export const VIDEO_FRAME = { width: 1080, height: 1920 } as const;

export type BackgroundStyle = 'solid' | 'gradient' | 'light';

export interface TemplateDefinition {
  id: string;
  name: string;
  description: string;
  formats: readonly RenderFormat[];
  background: BackgroundStyle;
  /** Decorative opening quotation mark above the text. */
  quoteMark: boolean;
}

/**
 * Deterministic templates: layout and typography are code, text is never drawn by a generative
 * model. Adding a template means adding an entry here and, if needed, a background style.
 */
export const TEMPLATES: readonly TemplateDefinition[] = [
  {
    id: 'bold-quote',
    name: 'Bold quote',
    description: 'Solid brand colour with a large centred quote.',
    formats: ['image', 'carousel'],
    background: 'solid',
    quoteMark: true,
  },
  {
    id: 'gradient-quote',
    name: 'Gradient quote',
    description: 'Primary-to-secondary gradient behind a centred quote.',
    formats: ['image', 'carousel'],
    background: 'gradient',
    quoteMark: true,
  },
  {
    id: 'minimal-light',
    name: 'Minimal light',
    description: 'Light background, brand-coloured text and an accent rule.',
    formats: ['image', 'carousel'],
    background: 'light',
    quoteMark: false,
  },
  {
    id: 'captioned-clip',
    name: 'Captioned clip',
    description: 'Vertical sermon clip with burned-in captions and logo.',
    formats: ['video'],
    background: 'solid',
    quoteMark: false,
  },
];

const CATALOG_DEFAULTS: Record<RenderFormat, string> = {
  image: 'bold-quote',
  carousel: 'minimal-light',
  video: 'captioned-clip',
};

export const findTemplate = (id: string): TemplateDefinition | undefined =>
  TEMPLATES.find((template) => template.id === id);

/**
 * Picks the template for a render: the one asked for, else the church's default for this content
 * type, else the catalog default. A template that cannot produce the format is rejected.
 */
export function resolveTemplate(input: {
  format: RenderFormat;
  contentType: ContentType;
  requested?: string;
  churchDefaults: Partial<Record<ContentType, string>>;
}): TemplateDefinition {
  if (input.requested) {
    const template = findTemplate(input.requested);
    if (!template) throw validationError('templateId', 'Unknown template');
    if (!template.formats.includes(input.format))
      throw validationError(
        'templateId',
        `This template cannot render a ${input.format}`,
      );
    return template;
  }
  const preferred = findTemplate(input.churchDefaults[input.contentType] ?? '');
  if (preferred?.formats.includes(input.format)) return preferred;
  return findTemplate(CATALOG_DEFAULTS[input.format]) as TemplateDefinition;
}

// ───────────────────────── Captions ─────────────────────────

export interface TimedWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface TimedText {
  startTimeMs: number;
  endTimeMs: number;
  text: string;
  /** Real word timings (absolute) when transcription provided them. */
  words?: TimedWord[];
}

export interface CaptionCue {
  /** Relative to the start of the clip. */
  startMs: number;
  endMs: number;
  text: string;
  /** Each word's timing relative to the clip (drives word-by-word caption styles). */
  words?: TimedWord[];
}

const MAX_CUE_CHARS = 34;
const MAX_CUE_WORDS = 6;
const MIN_CUE_MS = 400;

/**
 * Words of a segment with their timings: the transcription's real word timings when present,
 * otherwise estimated from each word's share of the segment's characters (close to speech, but not
 * frame-accurate).
 */
export function segmentWords(segment: TimedText): TimedWord[] {
  if (segment.words && segment.words.length > 0)
    return segment.words.filter((word) => word.text.trim().length > 0);
  const tokens = segment.text.trim().split(/\s+/).filter(Boolean);
  const weight = tokens.reduce((sum, token) => sum + token.length + 1, 0);
  const duration = segment.endTimeMs - segment.startTimeMs;
  if (weight === 0 || duration <= 0) return [];
  const words: TimedWord[] = [];
  let cursor = segment.startTimeMs;
  for (const token of tokens) {
    const span = (duration * (token.length + 1)) / weight;
    words.push({ text: token, startMs: cursor, endMs: cursor + span });
    cursor += span;
  }
  return words;
}

/** Builds short caption cues for a clip from transcript segments (word timings where available). */
export function buildCaptionCues(
  segments: TimedText[],
  clipStartMs: number,
  clipEndMs: number,
): CaptionCue[] {
  const words: TimedWord[] = [];
  for (const segment of [...segments].sort(
    (a, b) => a.startTimeMs - b.startTimeMs,
  )) {
    if (segment.endTimeMs <= clipStartMs || segment.startTimeMs >= clipEndMs)
      continue;
    for (const word of segmentWords(segment)) {
      const midpoint = (word.startMs + word.endMs) / 2;
      if (midpoint >= clipStartMs && midpoint < clipEndMs) words.push(word);
    }
  }

  const cues: CaptionCue[] = [];
  let current: typeof words = [];
  const flush = () => {
    const first = current[0];
    const last = current[current.length - 1];
    if (!first || !last) return;
    const startMs = Math.max(0, Math.round(first.startMs - clipStartMs));
    const endMs = Math.min(
      clipEndMs - clipStartMs,
      Math.max(startMs + MIN_CUE_MS, Math.round(last.endMs - clipStartMs)),
    );
    if (endMs > startMs)
      cues.push({
        startMs,
        endMs,
        text: current.map((word) => word.text).join(' '),
        words: current.map((word) => ({
          text: word.text,
          startMs: Math.max(0, Math.round(word.startMs - clipStartMs)),
          endMs: Math.min(
            clipEndMs - clipStartMs,
            Math.round(word.endMs - clipStartMs),
          ),
        })),
      });
    current = [];
  };
  for (const word of words) {
    const length =
      current.reduce((sum, item) => sum + item.text.length + 1, 0) +
      word.text.length;
    if (
      current.length > 0 &&
      (current.length >= MAX_CUE_WORDS || length > MAX_CUE_CHARS)
    )
      flush();
    current.push(word);
    if (/[.!?]["'”’)]*$/.test(word.text)) flush();
  }
  flush();
  // Cues never overlap: a cue ends where the next one begins.
  for (let i = 0; i < cues.length - 1; i++) {
    const cue = cues[i];
    const next = cues[i + 1];
    if (cue && next && cue.endMs > next.startMs) cue.endMs = next.startMs;
  }
  // Word timings stay inside their cue, so word-by-word styles never draw outside it.
  for (const cue of cues)
    cue.words = cue.words?.map((word) => {
      const startMs = Math.min(Math.max(word.startMs, cue.startMs), cue.endMs);
      return {
        ...word,
        startMs,
        endMs: Math.min(Math.max(word.endMs, startMs), cue.endMs),
      };
    });
  return cues.filter((cue) => cue.endMs > cue.startMs);
}

// ───────────────────────── Carousel planner ─────────────────────────

export interface SlidePlan {
  heading?: string;
  text: string;
  attribution?: string;
}

export const MAX_CAROUSEL_SLIDES = 10;
const SLIDE_CHARS = 280;

/** Splits prose into chunks no longer than `maxChars`, breaking at sentence ends where possible. */
export function chunkText(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  for (const paragraph of text
    .split(/\n{2,}/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)) {
    const sentences = paragraph.match(/[^.!?]+[.!?]+["'”’)]*\s*|[^.!?]+$/g) ?? [
      paragraph,
    ];
    let current = '';
    for (const sentence of sentences
      .map((part) => part.trim())
      .filter(Boolean)) {
      if (sentence.length > maxChars) {
        if (current) chunks.push(current);
        current = '';
        // A single overlong sentence is split on word boundaries.
        let line = '';
        for (const word of sentence.split(' ')) {
          if (line && line.length + 1 + word.length > maxChars) {
            chunks.push(line);
            line = word;
          } else line = line ? `${line} ${word}` : word;
        }
        current = line;
      } else if (!current) current = sentence;
      else if (current.length + 1 + sentence.length <= maxChars)
        current += ` ${sentence}`;
      else {
        chunks.push(current);
        current = sentence;
      }
    }
    if (current) chunks.push(current);
  }
  return chunks;
}

/**
 * Lays content out as carousel slides: a cover with the title, the body in readable chunks, and
 * a closing slide pointing at the church when there is somewhere to point.
 */
export function planCarousel(input: {
  title: string;
  body: string;
  scripture?: string | null;
  churchName: string;
  callToAction?: string;
}): SlidePlan[] {
  const closing: SlidePlan | null = input.callToAction
    ? { heading: input.churchName, text: input.callToAction }
    : null;
  const bodyBudget = MAX_CAROUSEL_SLIDES - 1 - (closing ? 1 : 0);
  const chunks = chunkText(input.body, SLIDE_CHARS);
  const kept = chunks.slice(0, bodyBudget);
  if (chunks.length > bodyBudget && kept.length > 0) {
    const last = kept.length - 1;
    kept[last] = `${(kept[last] ?? '').replace(/[.!?…\s]+$/, '')}…`;
  }
  return [
    {
      heading: input.churchName,
      text: input.title,
      attribution: input.scripture ?? undefined,
    },
    ...kept.map((text) => ({ heading: input.title, text })),
    ...(closing ? [closing] : []),
  ];
}

// ───────────────────────── Clip window ─────────────────────────

export const MIN_CLIP_MS = 5_000;
/** Without an explicit window, a clip is the first minute of the content's sermon passage. */
export const DEFAULT_CLIP_MS = 60_000;

/**
 * Decides which part of the sermon a clip covers: the window the user asked for, else the passage
 * the content was generated from (its source timestamps), clamped to the allowed length.
 */
export function resolveClipWindow(input: {
  requested?: { startMs: number; endMs: number };
  source: { startTimeMs: number | null; endTimeMs: number | null };
  sermonDurationMs: number | null;
  maxClipMs: number;
}): { startMs: number; endMs: number } {
  const limit = input.sermonDurationMs ?? Number.POSITIVE_INFINITY;
  if (input.requested) {
    const { startMs, endMs } = input.requested;
    if (startMs < 0 || endMs <= startMs)
      throw validationError('clip', 'The clip must end after it starts');
    if (endMs - startMs < MIN_CLIP_MS)
      throw validationError('clip', 'Clips must be at least 5 seconds long');
    if (endMs - startMs > input.maxClipMs)
      throw validationError(
        'clip',
        `Clips can be at most ${Math.round(input.maxClipMs / 1000)} seconds long`,
      );
    if (endMs > limit)
      throw validationError('clip', 'The clip ends after the sermon does');
    return { startMs, endMs };
  }
  const { startTimeMs, endTimeMs } = input.source;
  if (startTimeMs === null || endTimeMs === null)
    throw validationError(
      'clip',
      'This content has no sermon timestamps; choose the start and end of the clip',
    );
  const startMs = Math.max(0, startTimeMs);
  const endMs = Math.min(
    endTimeMs,
    limit,
    startMs + Math.min(DEFAULT_CLIP_MS, input.maxClipMs),
  );
  if (endMs - startMs < MIN_CLIP_MS)
    throw validationError(
      'clip',
      'The sermon passage for this content is too short for a clip',
    );
  return { startMs, endMs };
}

// ───────────────────────── Render spec ─────────────────────────

/** Stored on a pending asset: exactly what the worker must render. Contains no secrets. */
export type RenderSpec =
  | {
      type: 'card';
      templateId: string;
      width: number;
      height: number;
      heading?: string;
      text: string;
      attribution?: string;
      pageLabel?: string;
      brand: BrandSnapshot;
    }
  | {
      type: 'video';
      templateId: string;
      /** Private source sermon media; only ever read by the worker. */
      sourceObjectKey: string;
      startMs: number;
      endMs: number;
      width: number;
      height: number;
      captions: CaptionCue[];
      brand: BrandSnapshot;
    }
  | {
      type: 'thumbnail';
      /** The rendered video (same render group) the frame is taken from. */
      videoAssetId: string;
      atMs: number;
    };

export function isRenderSpec(value: unknown): value is RenderSpec {
  const type = (value as { type?: unknown } | null)?.type;
  return type === 'card' || type === 'video' || type === 'thumbnail';
}

// ───────────────────────── Studio: constants ─────────────────────────

export const PRESIGN_TTL_SECONDS = 15 * 60;
export const ASSET_URL_TTL_SECONDS = 15 * 60;
/** How many uploaded logos the profile lists. */
export const ASSET_LIST_LIMIT = 20;
export const DEFAULT_ASSET_NAME = 'Logo';
export const DEFAULT_WATERMARK_POSITION = 'bottom-right';

export const brandLockKey = (churchId: string) => `brand-profile:${churchId}`;

// ───────────────────────── Studio: errors ─────────────────────────

export const uploadNotFound = (field: string) => validationError(field, 'Upload not found');
export const uploadIncomplete = (field: string) =>
  validationError(field, 'The file has not finished uploading');
export const uploadTooLarge = (field: string) =>
  validationError(field, 'The uploaded file is too large');
export const uploadTypeMismatch = (field: string) =>
  validationError(field, 'The uploaded file type does not match');

// ───────────────────────── Studio: views ─────────────────────────

/** An uploaded brand image, with a short-lived signed URL. */
export interface BrandAssetView {
  id: string;
  kind: 'LOGO';
  name: string;
  url: string;
  createdAt: string;
}

export interface BrandProfileView {
  churchId: string;
  churchName: string;
  logoAssetId: string | null;
  alternateLogoAssetId: string | null;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  headingFont: string;
  bodyFont: string;
  socialHandle: string | null;
  website: string | null;
  watermarkEnabled: boolean;
  watermarkPosition: string;
  footerText: string | null;
  voice: BrandProfile['voice'];
  assets: BrandAssetView[];
}

export function toBrandAssetView(asset: MediaAsset, url: string): BrandAssetView {
  const fileName = asset.metadata['fileName'];
  return {
    id: asset.id,
    kind: 'LOGO',
    name: typeof fileName === 'string' && fileName ? fileName : DEFAULT_ASSET_NAME,
    url,
    createdAt: asset.createdAt.toISOString(),
  };
}

export const toBrandProfileView = (
  profile: BrandProfile,
  assets: BrandAssetView[],
): BrandProfileView => ({
  churchId: profile.churchId,
  churchName: profile.churchName,
  logoAssetId: profile.logoAssetId ?? null,
  alternateLogoAssetId: profile.alternateLogoAssetId ?? null,
  primaryColor: profile.primaryColor,
  secondaryColor: profile.secondaryColor,
  accentColor: profile.accentColor,
  headingFont: profile.headingFont,
  bodyFont: profile.bodyFont,
  socialHandle: profile.socialHandle ?? null,
  website: profile.website ?? null,
  watermarkEnabled: profile.watermarkEnabled,
  watermarkPosition: profile.watermarkPosition ?? DEFAULT_WATERMARK_POSITION,
  footerText: profile.footerText ?? null,
  voice: profile.voice,
  assets,
});

/** `null` in the body clears a field; the domain treats `undefined` as "unchanged". */
export const nullsToUndefined = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, entry ?? undefined]));

// ───────────────────────── Studio: request schemas ─────────────────────────

const term = z.string().max(80);

// Not strict: the web client sends back what it read, so unknown read-only keys are dropped.
const VoiceBody = z.object({
  tone: z.string().max(200),
  bibleTranslation: z.string().max(20).nullable(),
  emojiUsage: z.enum(EMOJI_USAGE, { error: 'Unknown emoji usage' }),
  writingStyle: z.string().max(500).nullable(),
  preferredTerms: z
    .array(z.object({ preferred: term, insteadOf: term.nullable().optional() }))
    .max(50),
  avoidPhrases: z.array(term).max(50),
  ctaStyle: z.string().max(200).nullable(),
  hashtagPreferences: z.array(z.string().max(60)).max(30),
});

/** Everything optional: PUT replaces the fields it carries; `null` clears an optional field. */
export const BrandBody = z
  .object({
    churchName: z.string().max(120),
    logoAssetId: z.string().uuid('Invalid asset id').nullable(),
    alternateLogoAssetId: z.string().uuid('Invalid asset id').nullable(),
    primaryColor: z.string().max(7),
    secondaryColor: z.string().max(7),
    accentColor: z.string().max(7),
    headingFont: z.string().max(60),
    bodyFont: z.string().max(60),
    socialHandle: z.string().max(51).nullable(),
    website: z.string().max(255).nullable(),
    footerText: z.string().max(120).nullable(),
    watermarkEnabled: z.boolean(),
    watermarkPosition: z
      .enum(WATERMARK_POSITIONS, { error: 'Unknown watermark position' })
      .nullable(),
    voice: VoiceBody.partial(),
  })
  .partial();

export const PresignBody = z.strictObject({
  fileName: z.string().min(1, 'File name is required').max(255),
  contentType: z.string().min(1).max(255),
  sizeBytes: z.number({ error: 'File size is required' }).int().positive(),
  kind: z.literal('LOGO', { error: 'Only logos can be uploaded' }).default('LOGO'),
});

// ───────────────────────── Render: jobs & constants ─────────────────────────

export interface RenderJobPayload {
  churchId: string;
  renderGroupId: string;
}

export const BRAND_RENDER_JOB = { queue: QUEUES.BRAND_RENDER, name: 'render-images' } as const;
export const VIDEO_RENDER_JOB = { queue: QUEUES.VIDEO_RENDER, name: 'render-clip' } as const;
export const RECOVER_RENDERS_JOB = { queue: QUEUES.MAINTENANCE, name: 'recover-stuck-renders' } as const;
export const RECOVER_RENDERS_EVERY_MS = 15 * 60_000;

export const STALE_RENDER_MS = 60 * 60 * 1000;
export const STALE_UPLOAD_MS = 24 * STALE_RENDER_MS;
export const STALE_UPLOAD_BATCH = 200;
export const THUMBNAIL_AT_MS = 1_000;
export const MEDIA_LIST_LIMIT = 100;
export const MEDIA_URL_TTL_SECONDS = 15 * 60;
export const DEFAULT_RENDER_MESSAGE = 'We could not render this media. Please try again.';
export const STALE_RENDER_MESSAGE = 'Rendering took too long. Please try again.';

export interface RenderRequest {
  format: RenderFormat;
  templateId?: string;
  aspect?: Aspect;
  /** Video only: overrides the passage the content was generated from. */
  clip?: { startMs: number; endMs: number };
  /** Single image only: replaces the card's heading and text. */
  overrides?: { headline?: string; body?: string };
}

export interface RenderAccepted {
  renderGroupId: string;
  assets: MediaAsset[];
}

// ───────────────────────── Render: errors ─────────────────────────

export const contentArchived = () =>
  new DomainError('UNPROCESSABLE', 'CONTENT_ARCHIVED', 'Archived content cannot be rendered.');

export const noSourceVideo = () =>
  new DomainError('UNPROCESSABLE', 'NO_SOURCE_VIDEO', 'Clips can only be made from sermons uploaded as video.');

export const sourceExpired = () =>
  new DomainError(
    'UNPROCESSABLE',
    'SOURCE_EXPIRED',
    'The original sermon video has been removed under your plan’s retention period, so new clips cannot be cut from it.',
  );

export const missingSource = (key: string) =>
  new PermanentJobError(
    `Source object ${key} is missing`,
    'The original media for this render is no longer available.',
  );

// ───────────────────────── Render: functions ─────────────────────────

export const extensionFor = (contentType: string) =>
  contentType === 'video/mp4' ? 'mp4' : contentType === 'image/jpeg' ? 'jpg' : 'png';

export const truncate = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

export function toCardSpec(spec: Extract<RenderSpec, { type: 'card' }>): CardSpec {
  const template = findTemplate(spec.templateId);
  if (!template) throw new PermanentJobError(`Unknown template ${spec.templateId}`);
  return {
    template,
    width: spec.width,
    height: spec.height,
    heading: spec.heading,
    text: spec.text,
    attribution: spec.attribution,
    pageLabel: spec.pageLabel,
    brand: spec.brand,
  };
}

export interface MediaAssetView {
  id: string;
  kind: MediaAsset['kind'];
  status: MediaAsset['status'];
  contentType: string;
  /** Short-lived signed URL; present only once the asset is ready. */
  url: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  renderGroupId: string | null;
  contentItemId: string | null;
  position: number;
  errorMessage: string | null;
  createdAt: string;
}

export const toMediaAssetView = (asset: MediaAsset, url: string | null): MediaAssetView => ({
  id: asset.id,
  kind: asset.kind,
  status: asset.status,
  contentType: asset.contentType,
  url: asset.status === 'READY' ? url : null,
  sizeBytes: asset.sizeBytes,
  width: asset.width,
  height: asset.height,
  durationMs: asset.durationMs,
  renderGroupId: asset.renderGroupId,
  contentItemId: asset.contentItemId,
  position: asset.position,
  errorMessage: asset.errorMessage,
  createdAt: asset.createdAt.toISOString(),
});

export const toRenderAcceptedResponse = (accepted: RenderAccepted, views: MediaAssetView[]) => ({
  renderGroupId: accepted.renderGroupId,
  status: 'rendering' as const,
  assets: views,
});

// ───────────────────────── Render: request schema ─────────────────────────

/** Formats the web app names (a placement, not a pipeline) mapped onto what the renderer produces. */
export const VISUAL_FORMATS = {
  'instagram-portrait': { format: 'image', aspect: 'portrait' },
  'instagram-square': { format: 'image', aspect: 'square' },
  'carousel-slide': { format: 'carousel', aspect: 'portrait' },
  story: { format: 'image', aspect: 'story' },
  facebook: { format: 'image', aspect: 'square' },
  'youtube-thumbnail': { format: 'image', aspect: 'square' },
} as const satisfies Record<string, { format: RenderFormat; aspect: Aspect }>;

export const RenderBody = z
  .strictObject({
    format: z
      .enum([...RENDER_FORMATS, ...(Object.keys(VISUAL_FORMATS) as Array<keyof typeof VISUAL_FORMATS>)], {
        error: 'Unknown format',
      })
      .default('image'),
    templateId: z.string().max(60).optional(),
    aspect: z.enum(ASPECT_NAMES).optional(),
    clip: z
      .strictObject({
        startMs: z.number().int().min(0),
        endMs: z.number().int().positive(),
      })
      .optional(),
    /** Replaces the text of a single image card. */
    overrides: z
      .strictObject({
        headline: z.string().trim().max(120).optional(),
        body: z.string().trim().max(600).optional(),
      })
      .optional(),
    /** Accepted for compatibility; custom backgrounds are not supported yet. */
    backgroundAssetId: z.string().uuid().nullable().optional(),
  })
  .refine((body) => body.format === 'video' || !body.clip, {
    message: 'Only video renders take a clip window',
    path: ['clip'],
  })
  .transform((body): RenderRequest => {
    const { format, backgroundAssetId: _background, ...rest } = body;
    const mapped = format in VISUAL_FORMATS ? VISUAL_FORMATS[format as keyof typeof VISUAL_FORMATS] : null;
    return {
      ...rest,
      format: mapped ? mapped.format : (format as RenderFormat),
      aspect: rest.aspect ?? mapped?.aspect,
    };
  });
