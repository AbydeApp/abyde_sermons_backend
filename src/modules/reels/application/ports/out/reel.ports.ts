import type {
  Page,
  PageRequest,
} from '../../../../../shared/domain/pagination.js';
import type {
  BrandSnapshot,
  BrandVoice,
} from '../../../../brand/domain/brand-profile.js';
import type {
  CaptionCue,
  TimedText,
} from '../../../../brand/domain/captions.js';
import type {
  CaptionPosition,
  CaptionStyle,
  HookStyle,
  LogoPosition,
  VideoSettings,
} from '../../../../brand/domain/video-settings.js';
import type { CropPlan, TrackingSample } from '../../../domain/crop-path.js';
import type {
  ReelCandidate,
  ReelCandidateDraft,
} from '../../../domain/reel-candidates.js';
import type {
  Reel,
  ReelRenderStage,
  ReelStatus,
} from '../../../domain/reel.js';

export const REEL_REPOSITORY = Symbol('REEL_REPOSITORY');

export interface ReelFilter {
  sermonId?: string;
  status?: ReelStatus;
}

export interface CompletedRender {
  outputAssetId: string;
  thumbnailAssetId: string;
  durationMs: number;
  sizeBytes: number;
  renderedAt: Date;
}

export interface ReelRepositoryPort {
  insert(reel: Reel): Promise<void>;
  findById(churchId: string, id: string): Promise<Reel | null>;
  list(
    churchId: string,
    filter: ReelFilter,
    page: PageRequest,
  ): Promise<Page<Reel>>;
  /** Saves user-facing fields and render requests (called under the per-Reel lock). */
  save(reel: Reel): Promise<void>;
  /** Reels of the church currently in a render stage (counts against the plan while in flight). */
  countRendering(churchId: string): Promise<number>;
  /**
   * Moves a render forward, only while the stored Reel is still rendering this attempt. False
   * when it was deleted, re-queued or already finished, so a stale worker stops.
   */
  advanceRender(
    churchId: string,
    id: string,
    renderAttempt: number,
    stage: ReelRenderStage,
    progress: number,
  ): Promise<boolean>;
  completeRender(
    churchId: string,
    id: string,
    renderAttempt: number,
    result: CompletedRender,
  ): Promise<boolean>;
  failRender(
    churchId: string,
    id: string,
    renderAttempt: number,
    message: string,
  ): Promise<boolean>;
  delete(churchId: string, id: string): Promise<void>;
  /** Maintenance only (all churches): fails renders with no progress since `olderThan`. */
  failStaleRenders(olderThan: Date, message: string): Promise<number>;
}

export const REEL_CANDIDATE_REPOSITORY = Symbol('REEL_CANDIDATE_REPOSITORY');

export interface ReelCandidateRepositoryPort {
  /** Replaces every candidate of the sermon (idempotent re-runs). */
  replaceForSermon(
    churchId: string,
    sermonId: string,
    candidates: ReelCandidate[],
  ): Promise<void>;
  /** Best first. */
  listForSermon(churchId: string, sermonId: string): Promise<ReelCandidate[]>;
  findById(churchId: string, id: string): Promise<ReelCandidate | null>;
}

export type { ReelCandidateDraft };

export const REEL_SOURCE = Symbol('REEL_SOURCE');

export interface ReelSermon {
  id: string;
  title: string;
  speaker: string;
  status: string;
  sourceType: string;
  durationMs: number | null;
  summary: string | null;
  mainTheme: string | null;
  /** Processing run; candidate jobs from older runs are ignored. */
  processingAttempts: number;
}

export interface ReelVideoSource {
  /** Private storage key of the original upload; only the worker reads it. */
  objectKey: string;
  contentType: string;
  /** Set once the retention sweep removed the original. */
  removedAt: Date | null;
}

/** Read access to the sermon a Reel is cut from (church-scoped). */
export interface ReelSourcePort {
  findSermon(churchId: string, sermonId: string): Promise<ReelSermon | null>;
  findVideo(
    churchId: string,
    sermonId: string,
  ): Promise<ReelVideoSource | null>;
  /** Transcript segments with word timings where available. */
  transcript(churchId: string, sermonId: string): Promise<TimedText[]>;
}

export const REEL_BRAND = Symbol('REEL_BRAND');

export interface ReelBrand {
  snapshot: BrandSnapshot;
  videoSettings: VideoSettings;
  voice: BrandVoice;
}

export interface ReelBrandPort {
  load(churchId: string): Promise<ReelBrand>;
}

export const SPEAKER_TRACKER = Symbol('SPEAKER_TRACKER');

export interface TrackingResult {
  provider: string;
  samples: TrackingSample[];
}

/** Finds where the speaker is over a clip. Replaceable (local MediaPipe/OpenCV, third party, none). */
export interface SpeakerTrackingPort {
  analyze(input: {
    videoPath: string;
    startMs: number;
    endMs: number;
    width: number;
    height: number;
    signal?: AbortSignal;
  }): Promise<TrackingResult>;
}

export const REEL_RENDERER = Symbol('REEL_RENDERER');

export interface ProbedVideo {
  width: number;
  height: number;
  durationMs: number;
  hasAudio: boolean;
}

export interface RenderReelInput {
  /** Scratch directory owned by the caller; the renderer only writes inside it. */
  workDir: string;
  sourcePath: string;
  source: ProbedVideo;
  startMs: number;
  endMs: number;
  width: number;
  height: number;
  /** Null when the source is already vertical (the frame is fitted instead of cropped). */
  crop: CropPlan | null;
  hook: { text: string; style: HookStyle; durationMs: number } | null;
  captions: {
    style: CaptionStyle;
    position: CaptionPosition;
    cues: CaptionCue[];
  };
  labels: { speaker?: string; church?: string };
  brand: BrandSnapshot;
  logoPath?: string;
  logoPosition: LogoPosition;
  outro: {
    durationMs: number;
    churchName: string;
    handle?: string;
    website?: string;
  } | null;
  /** Reports the stage the renderer is in (drives progress in the UI). */
  onStage(stage: ReelRenderStage): Promise<void>;
  signal?: AbortSignal;
}

export interface RenderedReel {
  filePath: string;
  contentType: string;
  width: number;
  height: number;
  durationMs: number;
  thumbnail: {
    filePath: string;
    contentType: string;
    width: number;
    height: number;
  };
}

/** Turns a sermon moment into a finished vertical video. Works on local files only. */
export interface ReelRendererPort {
  probe(path: string, signal?: AbortSignal): Promise<ProbedVideo>;
  render(input: RenderReelInput): Promise<RenderedReel>;
}

export const REEL_MEDIA = Symbol('REEL_MEDIA');

export interface StoredReelMedia {
  videoAssetId: string;
  thumbnailAssetId: string;
  videoSizeBytes: number;
  thumbnailSizeBytes: number;
}

/**
 * Stores rendered files as Brand Studio media assets, so a Reel can be attached to social posts
 * like any generated media. Asset ids are derived from (Reel, attempt): a retried job overwrites
 * the same objects and rows instead of creating new ones.
 */
export interface ReelMediaPort {
  store(input: {
    churchId: string;
    sermonId: string;
    reelId: string;
    renderAttempt: number;
    rendered: RenderedReel;
    signal?: AbortSignal;
  }): Promise<StoredReelMedia>;
  /** Removes stored output that no Reel points at (render superseded or Reel deleted meanwhile). */
  discard(churchId: string, assetIds: string[]): Promise<void>;
  /** Short-lived URL the web app can play or download. */
  url(churchId: string, assetId: string): Promise<string | null>;
}

export const REEL_SETTINGS = Symbol('REEL_SETTINGS');

export interface ReelSettings {
  minSeconds: number;
  maxSeconds: number;
  hookSeconds: number;
  outroSeconds: number;
}

export const REEL_OBSERVER = Symbol('REEL_OBSERVER');

/** Render metrics hook, implemented by the observability layer. */
export interface ReelObserverPort {
  rendered(durationMs: number, ok: boolean): void;
  candidatesGenerated(count: number): void;
}
