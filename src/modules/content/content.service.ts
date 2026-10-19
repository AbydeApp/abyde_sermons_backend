import { Inject, Injectable } from '@nestjs/common';
import { assertAIBudget } from '../../shared/application/ai-budget.js';
import { CHURCH_PROFILE, type ChurchProfilePort } from '../../shared/application/church-profile.js';
import { CACHE, type CachePort } from '../../shared/application/ports/cache.port.js';
import { CLOCK, type ClockPort } from '../../shared/application/ports/clock.port.js';
import { STORAGE, type StoragePort } from '../../shared/application/ports/storage.port.js';
import { UNIT_OF_WORK, type UnitOfWorkPort } from '../../shared/application/ports/unit-of-work.port.js';
import { notFound, validationError } from '../../shared/domain/domain-error.js';
import { newId } from '../../shared/domain/id.js';
import type { Page, PageRequest } from '../../shared/domain/pagination.js';
import { MEDIA_ASSET_REPOSITORY, type MediaAssetRepositoryPort } from '../brand/brand.repository.js';
import { ContentGenerationService } from './adapters/content-generator.js';
import { SERMON_CONTEXT, type SermonContextPort } from './adapters/sermon-context.adapter.js';
import {
  CALENDAR_REPOSITORY, type CalendarRepositoryPort, CONTENT_QUERY, CONTENT_REPOSITORY, type ContentFilter,
  type ContentQueryPort, type ContentRepositoryPort, type ContentRow,
} from './content.repository.js';
import {
  aiBusyKey, AI_BUSY_TTL_SECONDS, buildVisual, CalendarItem, type CalendarRow, contentBusy, contentLockKey,
  type ContentItem, type ContentPatch, type ContentType, type ContentVersionRecord, type ContentView, generationFailed,
  latestRender, MAX_CALENDAR_RANGE_MS, noAlternative, type RewriteAction, SIBLING_PAGE_SIZE, VISUAL_ASSET_LIMIT,
  VISUAL_URL_TTL_SECONDS,
} from './helper.js';

/** Content items (edit, approve, AI rewrite, versions) and their calendar entries. */
@Injectable()
export class ContentService {
  constructor(
    @Inject(CONTENT_REPOSITORY) private readonly contents: ContentRepositoryPort,
    @Inject(CALENDAR_REPOSITORY) private readonly calendar: CalendarRepositoryPort,
    @Inject(CONTENT_QUERY) private readonly query: ContentQueryPort,
    @Inject(MEDIA_ASSET_REPOSITORY) private readonly media: MediaAssetRepositoryPort,
    @Inject(SERMON_CONTEXT) private readonly sermons: SermonContextPort,
    @Inject(CHURCH_PROFILE) private readonly profiles: ChurchProfilePort,
    @Inject(ContentGenerationService) private readonly generator: ContentGenerationService,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  // ───────────── Content ─────────────

  async list(churchId: string, filter: ContentFilter, page: PageRequest): Promise<Page<ContentView>> {
    const result = await this.query.list(churchId, filter, page);
    return { ...result, items: await this.present(churchId, result.items) };
  }

  get(churchId: string, id: string): Promise<ContentView> {
    return this.view(churchId, id);
  }

  update(churchId: string, id: string, patch: ContentPatch): Promise<ContentView> {
    return this.mutate(churchId, id, (item) => item.edit(patch, this.clock.now()));
  }

  approve(churchId: string, id: string): Promise<ContentView> {
    return this.mutate(churchId, id, (item) => item.approve(this.clock.now()));
  }

  async rewrite(churchId: string, id: string, action: RewriteAction): Promise<ContentView> {
    const current = await this.load(churchId, id);
    current.assertEditable(); // fail fast before spending an AI call
    return this.exclusiveAI(churchId, id, async () => {
      const rewritten = await this.generator.rewrite(
        {
          type: current.type,
          title: current.title,
          body: current.body,
          scripture: current.scripture,
          action,
          churchId,
          sermonId: current.sermonId,
        },
        await this.profiles.findAIProfile(churchId),
      );
      return this.mutate(churchId, id, (item) =>
        item.applyAIRevision(
          { title: rewritten.title, body: rewritten.body, scripture: rewritten.scripture },
          'AI_REWRITE',
          rewritten.ai,
          this.clock.now(),
        ),
      );
    });
  }

  async regenerate(churchId: string, id: string): Promise<ContentView> {
    const current = await this.load(churchId, id);
    current.assertEditable();
    const sermon = await this.sermons.load(churchId, current.sermonId);
    if (!sermon) throw notFound('Sermon');
    return this.exclusiveAI(churchId, id, async () => {
      // A regenerated quote must be a different quote, not this one or one of its siblings.
      const exclude =
        current.type === 'QUOTE' ? await this.siblingBodies(churchId, current.sermonId, 'QUOTE') : [];
      const output = await this.generator.generate(
        current.type,
        sermon,
        await this.profiles.findAIProfile(churchId),
        1,
        exclude,
      );
      const piece = output.pieces[0];
      if (!piece) throw current.type === 'QUOTE' ? noAlternative() : generationFailed();
      return this.mutate(churchId, id, (item) =>
        item.applyAIRevision(
          { title: piece.title, body: piece.body, scripture: piece.scripture },
          'AI_GENERATED',
          output.ai,
          this.clock.now(),
          piece.sourceMetadata,
        ),
      );
    });
  }

  async remove(churchId: string, id: string): Promise<void> {
    await this.uow.runLocked(contentLockKey(id), async () => {
      if (!(await this.contents.findById(churchId, id))) throw notFound('Content');
      (await this.calendar.findByContentItem(churchId, id))?.assertNotPublishing();
      await this.contents.delete(churchId, id); // calendar entry and versions cascade
    });
  }

  async versions(churchId: string, id: string): Promise<ContentVersionRecord[]> {
    if (!(await this.contents.findById(churchId, id))) throw notFound('Content');
    return this.contents.listVersions(churchId, id);
  }

  async restoreVersion(churchId: string, id: string, version: number): Promise<ContentView> {
    const record = await this.contents.findVersion(churchId, id, version);
    if (!record) throw notFound('Version');
    return this.mutate(churchId, id, (item) => item.restoreVersion(record, this.clock.now()));
  }

  // ───────────── Calendar ─────────────

  listCalendar(churchId: string, from: Date, to: Date): Promise<CalendarRow[]> {
    if (to < from) throw validationError('to', '"to" must be after "from"');
    if (to.getTime() - from.getTime() > MAX_CALENDAR_RANGE_MS)
      throw validationError('to', 'Date range is too large');
    return this.calendar.listRange(churchId, from, to);
  }

  /** Idempotent per content item: scheduling already-scheduled content moves its existing entry. */
  async schedule(churchId: string, input: { contentItemId: string; scheduledAt: Date }): Promise<CalendarRow> {
    const calendarId = await this.uow.runLocked(contentLockKey(input.contentItemId), async () => {
      const now = this.clock.now();
      const item = await this.contents.findById(churchId, input.contentItemId);
      if (!item) throw notFound('Content');
      let entry = await this.calendar.findByContentItem(churchId, input.contentItemId);
      if (entry) entry.reschedule(input.scheduledAt, now);
      else
        entry = CalendarItem.schedule({
          id: newId(),
          churchId,
          contentItemId: item.id,
          scheduledAt: input.scheduledAt,
          now,
        });
      item.schedule(input.scheduledAt, now);
      await this.contents.save(item);
      await this.calendar.save(entry);
      return entry.id;
    });
    const [row] = await this.calendar.findRows(churchId, [calendarId]);
    if (!row) throw notFound('Calendar item');
    return row;
  }

  async reschedule(churchId: string, id: string, scheduledAt: Date): Promise<CalendarRow> {
    const entry = await this.calendar.findById(churchId, id);
    if (!entry) throw notFound('Calendar item');
    return this.schedule(churchId, { contentItemId: entry.contentItemId, scheduledAt });
  }

  async unschedule(churchId: string, id: string): Promise<void> {
    const entry = await this.calendar.findById(churchId, id);
    if (!entry) throw notFound('Calendar item');
    await this.uow.runLocked(contentLockKey(entry.contentItemId), async () => {
      const fresh = await this.calendar.findById(churchId, id);
      if (!fresh) return; // already removed by a concurrent request
      fresh.assertNotPublishing();
      const item = await this.contents.findById(churchId, fresh.contentItemId);
      await this.calendar.delete(churchId, id);
      if (item && item.status !== 'PUBLISHED') {
        item.unschedule(this.clock.now());
        await this.contents.save(item);
      }
    });
  }

  // ───────────── Internals ─────────────

  private async load(churchId: string, id: string): Promise<ContentItem> {
    const item = await this.contents.findById(churchId, id);
    if (!item) throw notFound('Content');
    return item;
  }

  /** Runs `change` under the item's lock, persists it and removes its calendar entry when required. */
  private async mutate(
    churchId: string,
    id: string,
    change: (item: ContentItem) => { unschedule: boolean } | void,
  ): Promise<ContentView> {
    await this.uow.runLocked(contentLockKey(id), async () => {
      const item = await this.load(churchId, id);
      const calendarItem = await this.calendar.findByContentItem(churchId, id);
      calendarItem?.assertNotPublishing();
      const result = change(item);
      if (result?.unschedule && calendarItem) await this.calendar.delete(churchId, calendarItem.id);
      await this.contents.save(item);
    });
    return this.view(churchId, id);
  }

  /**
   * Allows one AI rewrite/regeneration per item at a time. A second request while the first is
   * running is rejected, so a double-click cannot cause two billed model calls and two versions.
   */
  private async exclusiveAI<T>(churchId: string, id: string, work: () => Promise<T>): Promise<T> {
    const key = aiBusyKey(id);
    if (!(await this.cache.setIfAbsent(key, 1, AI_BUSY_TTL_SECONDS))) throw contentBusy();
    try {
      await assertAIBudget(this.cache, churchId, 'edit');
      return await work();
    } finally {
      await this.cache.del(key);
    }
  }

  private async siblingBodies(churchId: string, sermonId: string, type: ContentType): Promise<string[]> {
    const page = await this.query.list(churchId, { sermonId, type }, { page: 1, pageSize: SIBLING_PAGE_SIZE });
    return page.items.map((row) => row.body);
  }

  private async view(churchId: string, id: string): Promise<ContentView> {
    const [row] = await this.query.findRows(churchId, [id]);
    if (!row) throw notFound('Content');
    const [view] = await this.present(churchId, [row]);
    if (!view) throw notFound('Content');
    return view;
  }

  /** Source evidence and render state for a page of content, with batched lookups (no N+1). */
  private async present(churchId: string, rows: ContentRow[]): Promise<ContentView[]> {
    if (rows.length === 0) return [];
    const segmentIds = [...new Set(rows.flatMap((row) => row.sourceMetadata.transcriptSegmentIds))];
    const [segments, scriptureDisplays, mediaAssets] = await Promise.all([
      this.sermons.findSegments(churchId, segmentIds),
      this.sermons.findScriptureDisplays(churchId, [...new Set(rows.map((row) => row.sermonId))]),
      this.media.listByContentIds(churchId, rows.map((row) => row.id), VISUAL_ASSET_LIMIT),
    ]);
    const segmentById = new Map(segments.map((segment) => [segment.id, segment]));

    const assetsByContent = new Map<string, typeof mediaAssets>();
    for (const asset of mediaAssets) {
      if (!asset.contentItemId) continue;
      assetsByContent.set(asset.contentItemId, [...(assetsByContent.get(asset.contentItemId) ?? []), asset]);
    }
    const renders = new Map(rows.map((row) => [row.id, latestRender(assetsByContent.get(row.id) ?? [])]));
    const urls = new Map<string, string>();
    await Promise.all(
      [...renders.values()].flat().filter((asset) => asset.status === 'READY').map(async (asset) => {
        urls.set(asset.id, await this.storage.createDownloadUrl(asset.objectKey, VISUAL_URL_TTL_SECONDS));
      }),
    );

    return rows.map((row) => {
      const resolvedScriptures = row.sourceMetadata.scriptureReferenceIds.flatMap(
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
              ? [{ id: segment.id, startTimeMs: segment.startTimeMs, endTimeMs: segment.endTimeMs, text: segment.text }]
              : [];
          }),
          scriptures: resolvedScriptures.length > 0 ? resolvedScriptures : row.scripture ? [row.scripture] : [],
          verbatim: row.sourceMetadata.verbatim,
        },
        visual: buildVisual(renders.get(row.id) ?? [], urls),
      };
    });
  }
}
