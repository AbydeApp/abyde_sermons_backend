import type { BrandSnapshot, CaptionCue, TimedText } from '../helper.js';
import type { CardSpec } from './template-svg.js';

export const BRAND_RENDERER = Symbol('BRAND_RENDERER');

/** A file the renderer wrote into the caller's work directory, with its technical metadata. */
export interface RenderedMedia {
  filePath: string;
  contentType: string;
  width: number;
  height: number;
  durationMs?: number;
}

interface RenderContext {
  /** Scratch directory owned by the caller; the renderer only writes inside it. */
  workDir: string;
  /** Output file name (without directory or extension). */
  name: string;
  /** Aborts the render (job time limit or shutdown). */
  signal?: AbortSignal;
}

export interface RenderImageInput extends RenderContext {
  card: CardSpec;
  /** Local path of the logo to stamp, when the brand has one. */
  logoPath?: string;
}

export interface RenderCarouselInput extends Omit<RenderImageInput, 'card'> {
  cards: CardSpec[];
}

export interface RenderVideoInput extends RenderContext {
  /** Local path of the source sermon video. */
  sourcePath: string;
  startMs: number;
  endMs: number;
  width: number;
  height: number;
  captions: CaptionCue[];
  brand: BrandSnapshot;
  logoPath?: string;
}

export interface RenderThumbnailInput extends RenderContext {
  videoPath: string;
  atMs: number;
}

/**
 * Deterministic media rendering (templates, not generative models). The renderer works on local
 * files only; storing the result and recording the asset is the use case's job.
 */
export interface BrandRenderingPort {
  renderImage(input: RenderImageInput): Promise<RenderedMedia>;
  renderCarousel(input: RenderCarouselInput): Promise<RenderedMedia[]>;
  renderVideo(input: RenderVideoInput): Promise<RenderedMedia>;
  renderThumbnail(input: RenderThumbnailInput): Promise<RenderedMedia>;
}

export const MEDIA_SETTINGS = Symbol('MEDIA_SETTINGS');

export interface MediaSettings {
  maxClipSeconds: number;
}

export const MEDIA_OBSERVER = Symbol('MEDIA_OBSERVER');

/** Render metrics hook, implemented by the observability layer. */
export interface MediaObserverPort {
  rendered(kind: string, durationMs: number, ok: boolean): void;
}

export const SERMON_MEDIA = Symbol('SERMON_MEDIA');

export interface SermonVideoSource {
  /** Private storage key of the original sermon upload. */
  objectKey: string;
  contentType: string;
  durationMs: number | null;
  /** Set once the retention sweep removed the original upload. */
  removedAt: Date | null;
}

/** Read access to a sermon's original media and transcript timings, scoped to the church. */
export interface SermonMediaPort {
  /** The sermon's source video, or null when it was uploaded as audio, a document or text. */
  findVideoSource(
    churchId: string,
    sermonId: string,
  ): Promise<SermonVideoSource | null>;
  transcriptTimings(churchId: string, sermonId: string): Promise<TimedText[]>;
}
