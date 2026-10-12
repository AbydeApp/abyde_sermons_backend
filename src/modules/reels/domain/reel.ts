import {
  DomainError,
  validationError,
} from '../../../shared/domain/domain-error.js';
import {
  CAPTION_POSITIONS,
  CAPTION_STYLES,
  type CaptionPosition,
  type CaptionStyle,
  HOOK_STYLES,
  type HookStyle,
} from '../../brand/domain/video-settings.js';

/** Render pipeline stages, in order; exposed to the web app as progress. */
export const REEL_RENDER_STAGES = [
  'QUEUED',
  'PREPARING',
  'CROPPING',
  'ADDING_HOOK',
  'ADDING_CAPTIONS',
  'BRANDING',
  'ENCODING',
] as const;
export type ReelRenderStage = (typeof REEL_RENDER_STAGES)[number];

export const REEL_STATUSES = [
  'DRAFT',
  ...REEL_RENDER_STAGES,
  'COMPLETED',
  'FAILED',
] as const;
export type ReelStatus = (typeof REEL_STATUSES)[number];

export const isRendering = (status: ReelStatus): status is ReelRenderStage =>
  (REEL_RENDER_STAGES as readonly string[]).includes(status);

/** Coarse progress per stage (encoding dominates wall-clock time). */
export const STAGE_PROGRESS: Record<ReelStatus, number> = {
  DRAFT: 0,
  QUEUED: 0,
  PREPARING: 5,
  CROPPING: 15,
  ADDING_HOOK: 30,
  ADDING_CAPTIONS: 40,
  BRANDING: 50,
  ENCODING: 60,
  COMPLETED: 100,
  FAILED: 0,
};

export interface ReelHook {
  /** On-screen copy written by the church (never presented as the pastor's words). */
  text: string;
  style: HookStyle;
}

export interface Reel {
  id: string;
  churchId: string;
  sermonId: string;
  candidateId: string | null;
  title: string;
  startMs: number;
  endMs: number;
  /** What the pastor says in the window, taken from the transcript. */
  transcript: string;
  hook: ReelHook | null;
  /** The last AI hook suggestions, kept so the UI can show them again. */
  hookOptions: ReelHook[];
  captionStyle: CaptionStyle;
  captionPosition: CaptionPosition;
  status: ReelStatus;
  progress: number;
  /** Increments with every render request; jobs carry it, so stale jobs stop. */
  renderAttempt: number;
  /** Changed since the last completed render (the stored video no longer matches). */
  editedSinceRender: boolean;
  outputAssetId: string | null;
  thumbnailAssetId: string | null;
  durationMs: number | null;
  sizeBytes: number | null;
  errorMessage: string | null;
  approvedAt: Date | null;
  renderRequestedAt: Date | null;
  renderedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReelWindowRules {
  minMs: number;
  maxMs: number;
}

export function validateWindow(
  window: { startMs: number; endMs: number },
  rules: ReelWindowRules,
  sermonDurationMs: number | null,
): void {
  const { startMs, endMs } = window;
  if (!Number.isInteger(startMs) || !Number.isInteger(endMs) || startMs < 0)
    throw validationError('startMs', 'Use whole milliseconds from 0');
  if (endMs <= startMs)
    throw validationError('endMs', 'The Reel must end after it starts');
  if (endMs - startMs < rules.minMs)
    throw validationError(
      'endMs',
      `Reels must be at least ${Math.round(rules.minMs / 1000)} seconds long`,
    );
  if (endMs - startMs > rules.maxMs)
    throw validationError(
      'endMs',
      `Reels can be at most ${Math.round(rules.maxMs / 1000)} seconds long`,
    );
  if (sermonDurationMs !== null && endMs > sermonDurationMs)
    throw validationError('endMs', 'The Reel ends after the sermon does');
}

export const MAX_HOOK_CHARS = 90;
const WRAPPING_QUOTES = /^["'“”‘’«»]+|["'“”‘’«»]+$/g;

/**
 * Hooks are the church's words on screen, not a quote: wrapping quotation marks are removed so a
 * hook can never be presented as something the pastor said.
 */
export function normalizeHookText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().replace(WRAPPING_QUOTES, '').trim();
}

export function validateHook(hook: { text: string; style: string }): ReelHook {
  if (!(HOOK_STYLES as readonly string[]).includes(hook.style))
    throw validationError('hook.style', 'Unknown hook style');
  const text = normalizeHookText(hook.text);
  if (!text) throw validationError('hook.text', 'Hook text is required');
  if (text.length > MAX_HOOK_CHARS)
    throw validationError(
      'hook.text',
      `Hooks can be at most ${MAX_HOOK_CHARS} characters`,
    );
  return { text, style: hook.style as HookStyle };
}

export interface ReelEdit {
  title?: string;
  hook?: { text: string; style: string } | null;
  captionStyle?: string;
  captionPosition?: string;
  window?: { startMs: number; endMs: number; transcript: string };
}

const assertNotRendering = (reel: Reel) => {
  if (isRendering(reel.status))
    throw new DomainError(
      'CONFLICT',
      'REEL_RENDERING',
      'This Reel is rendering. Wait for it to finish before changing it.',
    );
};

/** Applies an edit; a finished Reel keeps its video but is marked out of date and unapproved. */
export function applyReelEdit(reel: Reel, edit: ReelEdit, now: Date): Reel {
  assertNotRendering(reel);
  if (
    edit.captionStyle !== undefined &&
    !(CAPTION_STYLES as readonly string[]).includes(edit.captionStyle)
  )
    throw validationError('captionStyle', 'Unknown caption style');
  if (
    edit.captionPosition !== undefined &&
    !(CAPTION_POSITIONS as readonly string[]).includes(edit.captionPosition)
  )
    throw validationError('captionPosition', 'Unknown caption position');
  const title =
    edit.title === undefined
      ? reel.title
      : edit.title.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!title) throw validationError('title', 'Title is required');
  const next: Reel = {
    ...reel,
    title,
    hook:
      edit.hook === undefined
        ? reel.hook
        : edit.hook === null
          ? null
          : validateHook(edit.hook),
    captionStyle: (edit.captionStyle as CaptionStyle) ?? reel.captionStyle,
    captionPosition:
      (edit.captionPosition as CaptionPosition) ?? reel.captionPosition,
    ...(edit.window
      ? {
          startMs: edit.window.startMs,
          endMs: edit.window.endMs,
          transcript: edit.window.transcript,
        }
      : {}),
    updatedAt: now,
  };
  const visualChange =
    JSON.stringify(next.hook) !== JSON.stringify(reel.hook) ||
    next.captionStyle !== reel.captionStyle ||
    next.captionPosition !== reel.captionPosition ||
    next.startMs !== reel.startMs ||
    next.endMs !== reel.endMs;
  if (visualChange && reel.renderedAt) {
    next.editedSinceRender = true;
    next.approvedAt = null;
  }
  return next;
}

/** Whether a render request has anything to do (renders are not repeated for an unchanged Reel). */
export function needsRender(reel: Reel): boolean {
  if (isRendering(reel.status)) return false;
  return reel.status !== 'COMPLETED' || reel.editedSinceRender;
}

export function queueRender(reel: Reel, now: Date): Reel {
  assertNotRendering(reel);
  return {
    ...reel,
    status: 'QUEUED',
    progress: STAGE_PROGRESS.QUEUED,
    renderAttempt: reel.renderAttempt + 1,
    errorMessage: null,
    approvedAt: null,
    renderRequestedAt: now,
    updatedAt: now,
  };
}

export function approveReel(reel: Reel, now: Date): Reel {
  if (reel.status !== 'COMPLETED' || reel.editedSinceRender)
    throw new DomainError(
      'CONFLICT',
      'REEL_NOT_RENDERED',
      'Render the latest version of this Reel before approving it.',
    );
  return reel.approvedAt ? reel : { ...reel, approvedAt: now, updatedAt: now };
}
