import type { SermonStatus } from '../../../../sermons/domain/processing.js';
import type {
  ScriptureReferenceRecord,
  SermonIntelligence,
  TranscriptSegmentRecord,
} from '../../../../sermons/domain/sermon-intelligence.js';

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
