import type { ContentVersionRecord } from '../../domain/content-item.entity.js';
import type { GenerationGroupRecord } from '../../domain/generation-group.js';
import { isGroupDone } from '../../domain/generation-group.js';
import type { ContentView } from '../../application/content-presenter.js';
import type { CalendarRow } from '../../application/ports/out/content-repository.port.js';

export const toContentResponse = (view: ContentView) => ({
  ...view,
  scheduledAt: view.scheduledAt?.toISOString() ?? null,
  publishedAt: view.publishedAt?.toISOString() ?? null,
  updatedAt: view.updatedAt.toISOString(),
});

export const toVersionResponse = (version: ContentVersionRecord) => ({
  version: version.version,
  title: version.title,
  body: version.body,
  source: version.source,
  aiProvider: version.aiProvider,
  aiModel: version.aiModel,
  createdAt: version.createdAt.toISOString(),
});

export const toGenerationGroupResponse = (group: GenerationGroupRecord) => ({
  id: group.id,
  sermonId: group.sermonId,
  jobs: group.jobs.map((job) => ({
    contentType: job.contentType,
    status: job.status,
    errorMessage: job.errorMessage,
  })),
  done: isGroupDone(group),
});

export const toCalendarResponse = (row: CalendarRow) => ({
  ...row,
  scheduledAt: row.scheduledAt.toISOString(),
});
