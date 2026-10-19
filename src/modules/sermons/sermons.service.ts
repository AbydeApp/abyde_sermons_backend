import { Inject, Injectable, Logger } from '@nestjs/common';
import { type PlanEntitlementsPort, PLAN_ENTITLEMENTS } from '../../shared/application/ports/plan-entitlements.port.js';
import { checkpoint, type RunGuard } from '../../shared/application/jobs.js';
import { CLOCK, type ClockPort } from '../../shared/application/ports/clock.port.js';
import { QUEUE, type QueuePort } from '../../shared/application/ports/queue.port.js';
import { STORAGE, type StoragePort } from '../../shared/application/ports/storage.port.js';
import { UNIT_OF_WORK, type UnitOfWorkPort } from '../../shared/application/ports/unit-of-work.port.js';
import { USAGE_METER, type UsageMeterPort } from '../../shared/application/ports/usage-meter.port.js';
import { notReady } from '../../shared/domain/domain-error.js';
import { newId } from '../../shared/domain/id.js';
import type { Page, PageRequest } from '../../shared/domain/pagination.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { SERMON_QUOTA, type SermonQuotaPort } from './adapters/ports.js';
import {
  cannotRetry, type CreateSermonInput, DAY_MS, EXPIRED_SOURCE_BATCH, INTERRUPTED_MESSAGE, intelligenceNotReady,
  MAX_PASTED_TRANSCRIPT_CHARS, MIN_TRANSCRIPT_CHARS, PROCESSING_STATUSES, Sermon, type SermonDetails, sermonCreateLockKey,
  sermonJobId, SERMON_JOBS, sermonLockKey, sermonNotFound, type SermonIntelligence,
  type SermonStatus, type SermonStatusInfo, type SermonView, sourceNotProvided, sourceTypeFor, STUCK_SERMON_AFTER_MS,
  STUCK_SERMON_BATCH, toStatusInfo, type TranscriptSegmentRecord, transcriptTooLong, transcriptTooShort,
  SERMON_QUERY_VISIBLE_STATUSES,
} from './helper.js';
import {
  INTELLIGENCE_REPOSITORY, type IntelligenceRepositoryPort, SERMON_QUERY, SERMON_REPOSITORY, type SermonQueryPort,
  type SermonRepositoryPort, TRANSCRIPT_REPOSITORY, type TranscriptRepositoryPort,
} from './sermons.repository.js';

/** Sermons as the web app sees them: create, edit, status/retry, transcript, intelligence, plus maintenance. */
@Injectable()
export class SermonsService {
  private readonly logger = new Logger(SermonsService.name);

  constructor(
    @Inject(SERMON_REPOSITORY) private readonly sermons: SermonRepositoryPort,
    @Inject(SERMON_QUERY) private readonly query: SermonQueryPort,
    @Inject(TRANSCRIPT_REPOSITORY) private readonly transcripts: TranscriptRepositoryPort,
    @Inject(INTELLIGENCE_REPOSITORY) private readonly intelligence: IntelligenceRepositoryPort,
    @Inject(UploadsService) private readonly uploads: UploadsService,
    @Inject(SERMON_QUOTA) private readonly quota: SermonQuotaPort,
    @Inject(PLAN_ENTITLEMENTS) private readonly entitlements: PlanEntitlementsPort,
    @Inject(USAGE_METER) private readonly usage: UsageMeterPort,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(QUEUE) private readonly queue: QueuePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  // ───────────── Create / read / edit / delete ─────────────

  async create(churchId: string, input: CreateSermonInput): Promise<{ id: string }> {
    const hasObject = input.objectKey !== undefined && input.objectKey !== '';
    const hasText = input.transcriptText !== undefined && input.transcriptText.trim() !== '';
    if (hasObject === hasText) throw sourceNotProvided(hasObject);
    if (hasText) {
      const length = input.transcriptText?.trim().length ?? 0;
      if (length < MIN_TRANSCRIPT_CHARS) throw transcriptTooShort();
      if (length > MAX_PASTED_TRANSCRIPT_CHARS) throw transcriptTooLong();
    }
    const { objectKey, transcriptText, ...details } = input;

    // The quota check, upload consumption and sermon insert are serialised per church so two
    // concurrent uploads cannot both squeeze under the plan limit. Storage is checked before the
    // transaction so a slow object store never holds the per-church lock or a pooled connection.
    const upload =
      hasObject && objectKey
        ? await this.uploads.verify({ churchId, objectKey, purpose: 'SERMON_MEDIA' })
        : null;

    const sermon = await this.uow.runLocked(sermonCreateLockKey(churchId), async () => {
      await this.quota.assertCanCreateSermon(churchId);
      if (upload) await this.uploads.claim(upload);
      const created = Sermon.create({
        id: newId(),
        churchId,
        sourceType: upload ? sourceTypeFor(upload.kind) : 'TEXT',
        details,
        now: this.clock.now(),
      });
      await this.sermons.insert(created);
      if (upload) {
        // Retention is fixed at upload time by the plan in force then.
        const { sourceRetentionDays } = await this.entitlements.allowance(churchId);
        await this.sermons.addAsset({
          id: newId(),
          churchId,
          sermonId: created.id,
          objectKey: upload.objectKey,
          contentType: upload.contentType,
          sizeBytes: upload.sizeBytes,
          expiresAt: new Date(this.clock.now().getTime() + sourceRetentionDays * DAY_MS),
          deletedAt: null,
        });
      } else if (transcriptText) {
        await this.transcripts.saveSourceText({
          id: newId(),
          churchId,
          sermonId: created.id,
          text: transcriptText.trim(),
        });
      }
      await this.usage.record({
        churchId,
        unit: 'SERMON_PROCESSED',
        quantity: 1,
        sermonId: created.id,
        dedupeKey: `sermon:${created.id}`,
      });
      return created;
    });

    const payload = { churchId, sermonId: sermon.id, attempt: sermon.processingAttempts };
    try {
      await this.queue.enqueue(SERMON_JOBS.START.queue, SERMON_JOBS.START.name, payload, {
        jobId: sermonJobId(payload, 'start'),
      });
    } catch (error) {
      // The sermon and its upload are already committed. Surface a retryable failure rather than
      // a 500 that would leave the sermon "queued" forever with nothing in the queue.
      this.logger.error({ err: error, sermonId: sermon.id }, 'Failed to enqueue sermon processing');
      sermon.markFailed('UPLOAD', 'We could not start processing this upload.', true);
      await this.sermons.updateProcessing(sermon);
    }
    return { id: sermon.id };
  }

  list(churchId: string, filter: { statuses?: SermonStatus[]; q?: string }, page: PageRequest): Promise<Page<SermonView>> {
    // ARCHIVED is hidden unless explicitly requested.
    const statuses = filter.statuses?.length ? filter.statuses : SERMON_QUERY_VISIBLE_STATUSES;
    return this.query.list(churchId, { q: filter.q, statuses }, page);
  }

  async get(churchId: string, id: string): Promise<SermonView> {
    const view = await this.query.findView(churchId, id);
    if (!view) throw sermonNotFound();
    return view;
  }

  async update(churchId: string, id: string, details: SermonDetails): Promise<SermonView> {
    const sermon = await this.sermons.findById(churchId, id);
    if (!sermon) throw sermonNotFound();
    sermon.updateDetails(details);
    if (!(await this.sermons.updateDetails(sermon))) throw sermonNotFound();
    return this.get(churchId, id);
  }

  /** Removes the sermon and everything derived from it (transcript, embeddings, content, calendar, files). */
  async remove(churchId: string, id: string): Promise<void> {
    const sermon = await this.sermons.findById(churchId, id);
    if (!sermon) throw sermonNotFound();
    const assets = await this.sermons.findAssets(churchId, id);
    await this.sermons.delete(churchId, id); // cascades in the database
    // Storage deletes run after the commit; failures leave orphans for the maintenance sweep, never dangling rows.
    for (const asset of assets.filter((stored) => !stored.deletedAt)) {
      await this.storage
        .deleteObject(asset.objectKey)
        .catch((error: unknown) => this.logger.warn({ err: error, sermonId: id }, 'Failed to delete sermon asset'));
    }
  }

  // ───────────── Status, retry, results ─────────────

  async status(churchId: string, id: string): Promise<SermonStatusInfo> {
    const sermon = await this.sermons.findById(churchId, id);
    if (!sermon) throw sermonNotFound();
    return toStatusInfo(sermon);
  }

  async retry(churchId: string, id: string): Promise<SermonStatusInfo> {
    const sermon = await this.uow.runLocked(sermonLockKey(id), async () => {
      const found = await this.sermons.findById(churchId, id);
      if (!found) throw sermonNotFound();
      found.retry();
      if (!(await this.sermons.updateForRetry(found))) throw cannotRetry();
      return found;
    });
    const payload = {
      churchId,
      sermonId: id,
      attempt: sermon.processingAttempts,
      fromStage: sermon.processingStage ?? 'UPLOAD',
    };
    await this.queue.enqueue(SERMON_JOBS.START.queue, SERMON_JOBS.START.name, payload, {
      jobId: sermonJobId(payload, 'start'),
    });
    return toStatusInfo(sermon);
  }

  async transcript(churchId: string, id: string): Promise<TranscriptSegmentRecord[]> {
    const sermon = await this.sermons.findById(churchId, id);
    if (!sermon) throw sermonNotFound();
    if (!sermon.isReady) throw notReady();
    return this.transcripts.listSegments(churchId, id);
  }

  async intelligenceOf(churchId: string, id: string): Promise<SermonIntelligence> {
    const sermon = await this.sermons.findById(churchId, id);
    if (!sermon) throw sermonNotFound();
    if (!sermon.isReady) throw notReady();
    const data = await this.intelligence.find(churchId, id);
    if (!data) throw intelligenceNotReady();
    return data;
  }

  // ───────────── Maintenance ─────────────

  /**
   * Deletes original sermon uploads whose plan retention has passed. Everything derived from them
   * (transcript, intelligence, content, rendered media, publishing records) stays. Processes current
   * state ("every expired original still stored"), so missed runs need no replay.
   */
  async purgeExpiredSources(guard?: RunGuard): Promise<number> {
    const now = this.clock.now();
    let removed = 0;
    for (const asset of await this.sermons.findExpiredAssets(now, EXPIRED_SOURCE_BATCH)) {
      await checkpoint(guard);
      // A sermon still being processed needs its original; it is removed on a later run.
      const sermon = await this.sermons.findById(asset.churchId, asset.sermonId);
      if (sermon && PROCESSING_STATUSES.includes(sermon.status)) continue;
      await this.storage.deleteObject(asset.objectKey);
      await this.sermons.markAssetDeleted(asset.churchId, asset.id, now);
      removed += 1;
    }
    if (removed > 0) this.logger.log({ removed }, 'Removed expired sermon originals');
    return removed;
  }

  /**
   * A sermon can be left "processing" with no job behind it when a worker is killed mid-job or the
   * queue was unavailable when the job was enqueued. Those sermons are marked FAILED at the stage
   * they reached, with retry enabled, so the user is never left with an endless spinner.
   */
  async recoverStuck(guard?: RunGuard): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - STUCK_SERMON_AFTER_MS);
    let recovered = 0;
    for (const candidate of await this.sermons.findStuckProcessing(cutoff, STUCK_SERMON_BATCH)) {
      await checkpoint(guard);
      const attempt = candidate.processingAttempts;
      await this.uow.runLocked(sermonLockKey(candidate.id), async () => {
        // Re-read under the lock: a late job or a user retry may have moved it on.
        const sermon = await this.sermons.findById(candidate.churchId, candidate.id);
        if (!sermon || !sermon.acceptsJobFor(attempt)) return;
        sermon.markFailed(sermon.processingStage ?? 'UPLOAD', INTERRUPTED_MESSAGE, true);
        if (await this.sermons.updateProcessing(sermon)) recovered++;
      });
    }
    if (recovered > 0) this.logger.warn({ recovered }, 'Marked stuck sermons as failed (retryable)');
    return recovered;
  }
}
