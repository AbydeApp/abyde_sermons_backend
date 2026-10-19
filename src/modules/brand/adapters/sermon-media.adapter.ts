import { Inject, Injectable } from '@nestjs/common';
import {
  SERMON_REPOSITORY,
  type SermonRepositoryPort,
} from '../../sermons/application/ports/out/sermon-repository.port.js';
import {
  TRANSCRIPT_REPOSITORY,
  type TranscriptRepositoryPort,
} from '../../sermons/application/ports/out/transcript-repository.port.js';
import type { TimedText } from '../helper.js';
import type { SermonMediaPort, SermonVideoSource } from './ports.js';

/** Adapter from the brand module onto the sermons module's read ports (one-way dependency). */
@Injectable()
export class SermonMediaAdapter implements SermonMediaPort {
  constructor(
    @Inject(SERMON_REPOSITORY) private readonly sermons: SermonRepositoryPort,
    @Inject(TRANSCRIPT_REPOSITORY)
    private readonly transcripts: TranscriptRepositoryPort,
  ) {}

  async findVideoSource(
    churchId: string,
    sermonId: string,
  ): Promise<SermonVideoSource | null> {
    const sermon = await this.sermons.findById(churchId, sermonId);
    if (!sermon || sermon.sourceType !== 'MEDIA') return null;
    const video = (await this.sermons.findAssets(churchId, sermonId)).find(
      (asset) => asset.contentType.startsWith('video/'),
    );
    if (!video) return null;
    return {
      objectKey: video.objectKey,
      contentType: video.contentType,
      durationMs: sermon.snapshot().durationMs,
      removedAt: video.deletedAt,
    };
  }

  async transcriptTimings(
    churchId: string,
    sermonId: string,
  ): Promise<TimedText[]> {
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
