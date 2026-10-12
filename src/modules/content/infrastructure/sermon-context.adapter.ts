import { Inject, Injectable } from '@nestjs/common';
import {
  SERMON_REPOSITORY,
  type SermonRepositoryPort,
} from '../../sermons/application/ports/out/sermon-repository.port.js';
import {
  INTELLIGENCE_REPOSITORY,
  type IntelligenceRepositoryPort,
  TRANSCRIPT_REPOSITORY,
  type TranscriptRepositoryPort,
} from '../../sermons/application/ports/out/transcript-repository.port.js';
import type { SermonStatus } from '../../sermons/domain/processing.js';
import type { TranscriptSegmentRecord } from '../../sermons/domain/sermon-intelligence.js';
import type {
  SermonContext,
  SermonContextPort,
} from '../application/ports/out/sermon-context.port.js';

/** Adapter from the content module onto the sermons module's read ports (one-way dependency). */
@Injectable()
export class SermonContextAdapter implements SermonContextPort {
  constructor(
    @Inject(SERMON_REPOSITORY) private readonly sermons: SermonRepositoryPort,
    @Inject(TRANSCRIPT_REPOSITORY)
    private readonly transcripts: TranscriptRepositoryPort,
    @Inject(INTELLIGENCE_REPOSITORY)
    private readonly intelligence: IntelligenceRepositoryPort,
  ) {}

  async findStatus(
    churchId: string,
    sermonId: string,
  ): Promise<SermonStatus | null> {
    return (await this.sermons.findById(churchId, sermonId))?.status ?? null;
  }

  async load(
    churchId: string,
    sermonId: string,
  ): Promise<SermonContext | null> {
    const sermon = await this.sermons.findById(churchId, sermonId);
    if (!sermon) return null;
    const [intelligence, segments, scriptureReferences] = await Promise.all([
      this.intelligence.find(churchId, sermonId),
      this.transcripts.listSegments(churchId, sermonId),
      this.intelligence.listScriptures(churchId, sermonId),
    ]);
    const props = sermon.snapshot();
    return {
      churchId,
      sermonId,
      title: props.title,
      speaker: props.speaker,
      sermonDate: props.sermonDate,
      status: props.status,
      intelligence,
      segments,
      scriptureReferences,
    };
  }

  findSegments(
    churchId: string,
    ids: string[],
  ): Promise<Array<TranscriptSegmentRecord & { sermonId: string }>> {
    return this.transcripts.findSegments(churchId, ids);
  }

  async findScriptureDisplays(
    churchId: string,
    sermonIds: string[],
  ): Promise<Map<string, string>> {
    const references = await this.intelligence.listScripturesForSermons(
      churchId,
      sermonIds,
    );
    return new Map(references.map((ref) => [ref.id, ref.display]));
  }
}
