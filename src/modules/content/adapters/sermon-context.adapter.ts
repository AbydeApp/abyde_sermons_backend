import { Inject, Injectable } from '@nestjs/common';
import { SERMON_REPOSITORY, type SermonRepositoryPort } from '../../sermons/sermons.repository.js';
import { INTELLIGENCE_REPOSITORY, type IntelligenceRepositoryPort, TRANSCRIPT_REPOSITORY, type TranscriptRepositoryPort } from '../../sermons/sermons.repository.js';
import type { SermonStatus } from '../../sermons/helper.js';
import type {
  ScriptureReferenceRecord,
  SermonIntelligence,
  TranscriptSegmentRecord,
} from '../../sermons/helper.js';

/** Everything content generation needs to stay grounded in one sermon of one church. */
export interface SermonContext {
  churchId: string;
  sermonId: string;
  title: string;
  speaker: string;
  sermonDate: Date;
  status: SermonStatus;
  intelligence: SermonIntelligence | null;
  segments: TranscriptSegmentRecord[];
  scriptureReferences: ScriptureReferenceRecord[];
}

export const SERMON_CONTEXT = Symbol('SERMON_CONTEXT');

export interface SermonContextPort {
  findStatus(churchId: string, sermonId: string): Promise<SermonStatus | null>;
  load(churchId: string, sermonId: string): Promise<SermonContext | null>;
  /** Segment text for source display, restricted to the church. */
  findSegments(
    churchId: string,
    ids: string[],
  ): Promise<Array<TranscriptSegmentRecord & { sermonId: string }>>;
  /** Display strings for scripture reference ids, restricted to the church. */
  findScriptureDisplays(
    churchId: string,
    sermonIds: string[],
  ): Promise<Map<string, string>>;
}

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
