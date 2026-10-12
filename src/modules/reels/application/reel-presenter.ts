import { Inject, Injectable } from '@nestjs/common';
import type { Reel, ReelHook, ReelStatus } from '../domain/reel.js';
import { isRendering } from '../domain/reel.js';
import { REEL_MEDIA, type ReelMediaPort } from './ports/out/reel.ports.js';

export interface ReelVideoSummary {
  assetId: string;
  thumbnailAssetId: string | null;
  durationMs: number | null;
  sizeBytes: number | null;
}

/** What the web app sees of a Reel: never storage keys; playback URLs only on the detail view. */
export interface ReelView {
  id: string;
  sermonId: string;
  candidateId: string | null;
  title: string;
  startMs: number;
  endMs: number;
  transcript: string;
  hook: ReelHook | null;
  hookOptions: ReelHook[];
  captionStyle: string;
  captionPosition: string;
  status: ReelStatus;
  rendering: boolean;
  progress: number;
  editedSinceRender: boolean;
  approvedAt: Date | null;
  errorMessage: string | null;
  /** Media asset ids of the last completed render (attach them to a social post). */
  video: (ReelVideoSummary & { url?: string; thumbnailUrl?: string }) | null;
  renderedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ReelPresenter {
  constructor(@Inject(REEL_MEDIA) private readonly media: ReelMediaPort) {}

  /** List item: no signed URLs (that would be one storage call per row). */
  summary(reel: Reel): ReelView {
    return {
      id: reel.id,
      sermonId: reel.sermonId,
      candidateId: reel.candidateId,
      title: reel.title,
      startMs: reel.startMs,
      endMs: reel.endMs,
      transcript: reel.transcript,
      hook: reel.hook,
      hookOptions: reel.hookOptions,
      captionStyle: reel.captionStyle,
      captionPosition: reel.captionPosition,
      status: reel.status,
      rendering: isRendering(reel.status),
      progress: reel.progress,
      editedSinceRender: reel.editedSinceRender,
      approvedAt: reel.approvedAt,
      errorMessage: reel.errorMessage,
      video: reel.outputAssetId
        ? {
            assetId: reel.outputAssetId,
            thumbnailAssetId: reel.thumbnailAssetId,
            durationMs: reel.durationMs,
            sizeBytes: reel.sizeBytes,
          }
        : null,
      renderedAt: reel.renderedAt,
      createdAt: reel.createdAt,
      updatedAt: reel.updatedAt,
    };
  }

  /** Detail: adds short-lived URLs to play the video and show its cover. */
  async view(reel: Reel): Promise<ReelView> {
    const view = this.summary(reel);
    if (!view.video) return view;
    const url = await this.media.url(reel.churchId, view.video.assetId);
    const thumbnailUrl = view.video.thumbnailAssetId
      ? await this.media.url(reel.churchId, view.video.thumbnailAssetId)
      : null;
    return {
      ...view,
      video: {
        ...view.video,
        ...(url ? { url } : {}),
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
      },
    };
  }
}
