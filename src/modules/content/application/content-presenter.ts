import { Inject, Injectable } from '@nestjs/common';
import type { ContentStatus, ContentType } from '../domain/content-types.js';
import type { ContentRow } from './ports/out/content-repository.port.js';
import {
  SERMON_CONTEXT,
  type SermonContextPort,
} from './ports/out/sermon-context.port.js';

export interface ContentView {
  id: string;
  type: ContentType;
  title: string;
  body: string;
  status: ContentStatus;
  sermonId: string;
  sermonTitle: string;
  scripture: string | null;
  calendarItemId: string | null;
  scheduledAt: Date | null;
  publishedAt: Date | null;
  currentVersion: number;
  updatedAt: Date;
  source: {
    sermonId: string;
    sermonTitle: string;
    segments: Array<{
      id: string;
      startTimeMs: number;
      endTimeMs: number;
      text: string;
    }>;
    scriptures: string[];
    verbatim: boolean;
  };
}

/** Resolves source evidence for a page of content with two batched lookups (no N+1). */
@Injectable()
export class ContentPresenter {
  constructor(
    @Inject(SERMON_CONTEXT) private readonly sermons: SermonContextPort,
  ) {}

  async present(churchId: string, rows: ContentRow[]): Promise<ContentView[]> {
    if (rows.length === 0) return [];
    const segmentIds = [
      ...new Set(
        rows.flatMap((row) => row.sourceMetadata.transcriptSegmentIds),
      ),
    ];
    const [segments, scriptureDisplays] = await Promise.all([
      this.sermons.findSegments(churchId, segmentIds),
      this.sermons.findScriptureDisplays(churchId, [
        ...new Set(rows.map((row) => row.sermonId)),
      ]),
    ]);
    const segmentById = new Map(
      segments.map((segment) => [segment.id, segment]),
    );
    return rows.map((row) => {
      const resolvedScriptures =
        row.sourceMetadata.scriptureReferenceIds.flatMap(
          (id) => scriptureDisplays.get(id) ?? [],
        );
      return {
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        status: row.status,
        sermonId: row.sermonId,
        sermonTitle: row.sermonTitle,
        scripture: row.scripture,
        calendarItemId: row.calendarItemId,
        scheduledAt: row.scheduledAt,
        publishedAt: row.publishedAt,
        currentVersion: row.currentVersion,
        updatedAt: row.updatedAt,
        source: {
          sermonId: row.sermonId,
          sermonTitle: row.sermonTitle,
          segments: row.sourceMetadata.transcriptSegmentIds.flatMap((id) => {
            const segment = segmentById.get(id);
            // Only segments from the same sermon are ever shown as evidence.
            return segment && segment.sermonId === row.sermonId
              ? [
                  {
                    id: segment.id,
                    startTimeMs: segment.startTimeMs,
                    endTimeMs: segment.endTimeMs,
                    text: segment.text,
                  },
                ]
              : [];
          }),
          scriptures:
            resolvedScriptures.length > 0
              ? resolvedScriptures
              : row.scripture
                ? [row.scripture]
                : [],
          verbatim: row.sourceMetadata.verbatim,
        },
      };
    });
  }
}
