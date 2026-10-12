import type { Sermon as SermonRow } from '../../../../generated/prisma/client.js';
import { Sermon, type SermonProps } from '../../domain/sermon.entity.js';
import type { SermonView } from '../../application/ports/out/sermon-repository.port.js';

export const toSermon = (row: SermonRow): Sermon =>
  Sermon.restore({
    id: row.id,
    churchId: row.churchId,
    title: row.title,
    speaker: row.speaker,
    sermonDate: row.sermonDate,
    series: row.series,
    mainScripture: row.mainScripture,
    tags: row.tags,
    status: row.status,
    processingStage: row.processingStage,
    failedStage: row.failedStage,
    errorMessage: row.errorMessage,
    canRetry: row.canRetry,
    sourceType: row.sourceType,
    summary: row.summary,
    mainTheme: row.mainTheme,
    themes: row.themes,
    scriptures: row.scriptures,
    durationMs: row.durationMs,
    processingAttempts: row.processingAttempts,
    readyAt: row.readyAt,
    createdAt: row.createdAt,
  });

export const toSermonData = (props: Readonly<SermonProps>) => ({ ...props });

export const toSermonView = (
  row: SermonRow,
  contentCount: number,
): SermonView => ({
  id: row.id,
  title: row.title,
  speaker: row.speaker,
  sermonDate: row.sermonDate,
  series: row.series,
  mainScripture: row.mainScripture,
  tags: row.tags,
  status: row.status,
  processingStage: row.status === 'READY' ? null : row.processingStage,
  summary: row.summary,
  mainTheme: row.mainTheme,
  scriptures: row.scriptures,
  themes: row.themes,
  contentCount,
  createdAt: row.createdAt,
});
