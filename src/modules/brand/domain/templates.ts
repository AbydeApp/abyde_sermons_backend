import { validationError } from '../../../shared/domain/domain-error.js';
import type { ContentType } from '../../content/domain/content-types.js';

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
