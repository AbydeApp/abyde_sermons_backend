import { Inject, Injectable } from '@nestjs/common';
import type { TimedText } from '../../brand/domain/captions.js';
import {
  SERMON_REPOSITORY,
  type SermonRepositoryPort,
} from '../../sermons/application/ports/out/sermon-repository.port.js';
import {
  TRANSCRIPT_REPOSITORY,
  type TranscriptRepositoryPort,
} from '../../sermons/application/ports/out/transcript-repository.port.js';
import type {
  ReelSermon,
  ReelSourcePort,
  ReelVideoSource,
} from '../application/ports/out/reel.ports.js';

/** Adapter from the reels module onto the sermons module's read ports (one-way dependency). */
@Injectable()
export class ReelSourceAdapter implements ReelSourcePort {
  constructor(
    @Inject(SERMON_REPOSITORY) private readonly sermons: SermonRepositoryPort,
    @Inject(TRANSCRIPT_REPOSITORY)
    private readonly transcripts: TranscriptRepositoryPort,
  ) {}

  async findSermon(
    churchId: string,
    sermonId: string,
  ): Promise<ReelSermon | null> {
    const sermon = await this.sermons.findById(churchId, sermonId);
    if (!sermon) return null;
    const props = sermon.snapshot();
    return {
      id: props.id,
      title: props.title,
      speaker: props.speaker,
      status: props.status,
      sourceType: props.sourceType,
      durationMs: props.durationMs,
      summary: props.summary,
      mainTheme: props.mainTheme,
      processingAttempts: props.processingAttempts,
    };
  }

  async findVideo(
    churchId: string,
    sermonId: string,
  ): Promise<ReelVideoSource | null> {
    const video = (await this.sermons.findAssets(churchId, sermonId)).find(
      (asset) => asset.contentType.startsWith('video/'),
    );
    return video
      ? {
          objectKey: video.objectKey,
          contentType: video.contentType,
          removedAt: video.deletedAt,
        }
      : null;
  }

  async transcript(churchId: string, sermonId: string): Promise<TimedText[]> {
    return (
      await this.transcripts.listSegmentsWithWords(churchId, sermonId)
    ).map((segment) => ({
      startTimeMs: segment.startTimeMs,
      endTimeMs: segment.endTimeMs,
      text: segment.text,
      ...(segment.words ? { words: segment.words } : {}),
    }));
  }
}
