import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  QUEUE,
  type QueuePort,
} from '../../../../shared/application/ports/queue.port.js';
import {
  CLOCK,
  type ClockPort,
} from '../../../../shared/application/ports/clock.port.js';
import {
  PLAN_ENTITLEMENTS,
  type PlanEntitlementsPort,
} from '../../../../shared/application/ports/plan-entitlements.port.js';
import {
  STORAGE,
  type StoragePort,
} from '../../../../shared/application/ports/storage.port.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '../../../../shared/application/ports/unit-of-work.port.js';
import {
  USAGE_METER,
  type UsageMeterPort,
} from '../../../../shared/application/ports/usage-meter.port.js';
import {
  DomainError,
  notFound,
  notReady,
  validationError,
} from '../../../../shared/domain/domain-error.js';
import { newId } from '../../../../shared/domain/id.js';
import type {
  Page,
  PageRequest,
} from '../../../../shared/domain/pagination.js';
import type { MediaKind } from '../../../uploads/helper.js';
import { UploadsService } from '../../../uploads/uploads.service.js';
import type {
  ProcessingStage,
  SermonSourceType,
  SermonStatus,
} from '../../domain/processing.js';
import { Sermon, type SermonDetails } from '../../domain/sermon.entity.js';
import type {
  SermonIntelligence,
  TranscriptSegmentRecord,
} from '../../domain/sermon-intelligence.js';
import {
  SERMON_QUOTA,
  type SermonQuotaPort,
} from '../ports/out/processing.ports.js';
import {
  SERMON_QUERY,
  SERMON_REPOSITORY,
  type SermonFilter,
  type SermonQueryPort,
  type SermonRepositoryPort,
  type SermonView,
} from '../ports/out/sermon-repository.port.js';
import {
  INTELLIGENCE_REPOSITORY,
  type IntelligenceRepositoryPort,
  TRANSCRIPT_REPOSITORY,
  type TranscriptRepositoryPort,
} from '../ports/out/transcript-repository.port.js';
import { SERMON_JOBS, sermonJobId } from '../sermon-jobs.js';

export interface CreateSermonInput {
  title: string;
  speaker: string;
  sermonDate: Date;
  series?: string | null;
  mainScripture?: string | null;
  tags?: string[];
  objectKey?: string;
  transcriptText?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_TRANSCRIPT_CHARS = 200;
const MAX_TRANSCRIPT_CHARS = 1_000_000;

const sourceTypeFor = (kind: MediaKind): SermonSourceType =>
  kind === 'AUDIO' || kind === 'VIDEO' ? 'MEDIA' : 'DOCUMENT';

@Injectable()
export class CreateSermonUseCase {
  private readonly logger = new Logger(CreateSermonUseCase.name);

  constructor(
    @Inject(SERMON_REPOSITORY) private readonly sermons: SermonRepositoryPort,
    @Inject(TRANSCRIPT_REPOSITORY)
    private readonly transcripts: TranscriptRepositoryPort,
    @Inject(UploadsService)
    private readonly consumeUpload: UploadsService,
    @Inject(SERMON_QUOTA) private readonly quota: SermonQuotaPort,
    @Inject(PLAN_ENTITLEMENTS)
    private readonly entitlements: PlanEntitlementsPort,
    @Inject(USAGE_METER) private readonly usage: UsageMeterPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(QUEUE) private readonly queue: QueuePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(
    churchId: string,
    input: CreateSermonInput,
  ): Promise<{ id: string }> {
    const hasObject = input.objectKey !== undefined && input.objectKey !== '';
    const hasText =
      input.transcriptText !== undefined && input.transcriptText.trim() !== '';
    if (hasObject === hasText) {
      throw validationError(
        hasObject ? 'transcriptText' : 'objectKey',
        'Provide either an uploaded file or a pasted transcript',
      );
    }
    if (hasText) {
      const length = input.transcriptText?.trim().length ?? 0;
      if (length < MIN_TRANSCRIPT_CHARS)
        throw validationError(
          'transcriptText',
          'The transcript is too short to analyse',
        );
      if (length > MAX_TRANSCRIPT_CHARS)
        throw validationError('transcriptText', 'The transcript is too long');
    }
    const { objectKey, transcriptText, ...details } = input;

    // The quota check, upload consumption and sermon insert are serialised per church so two
    // concurrent uploads cannot both squeeze under the plan limit.
    // Storage is checked before the transaction so a slow object store never holds the
    // per-church lock or a pooled connection.
    const upload =
      hasObject && objectKey
        ? await this.consumeUpload.verify({
            churchId,
            objectKey,
            purpose: 'SERMON_MEDIA',
          })
        : null;

    const sermon = await this.uow.runLocked(
      `sermon:create:${churchId}`,
      async () => {
        await this.quota.assertCanCreateSermon(churchId);
        if (upload) await this.consumeUpload.claim(upload);
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
          const { sourceRetentionDays } =
            await this.entitlements.allowance(churchId);
          await this.sermons.addAsset({
            id: newId(),
            churchId,
            sermonId: created.id,
            objectKey: upload.objectKey,
            contentType: upload.contentType,
            sizeBytes: upload.sizeBytes,
            expiresAt: new Date(
              this.clock.now().getTime() + sourceRetentionDays * DAY_MS,
            ),
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
      },
    );

    const payload = {
      churchId,
      sermonId: sermon.id,
      attempt: sermon.processingAttempts,
    };
    try {
      await this.queue.enqueue(
        SERMON_JOBS.START.queue,
        SERMON_JOBS.START.name,
        payload,
        { jobId: sermonJobId(payload, 'start') },
      );
    } catch (error) {
      // The sermon and its upload are already committed. Surface a retryable failure rather than
      // a 500 that would leave the sermon "queued" forever with nothing in the queue.
      this.logger.error(
        { err: error, sermonId: sermon.id },
        'Failed to enqueue sermon processing',
      );
      sermon.markFailed(
        'UPLOAD',
        'We could not start processing this upload.',
        true,
      );
      await this.sermons.updateProcessing(sermon);
    }
    return { id: sermon.id };
  }
}

@Injectable()
export class ListSermonsUseCase {
  constructor(@Inject(SERMON_QUERY) private readonly query: SermonQueryPort) {}

  execute(
    churchId: string,
    filter: { statuses?: SermonStatus[]; q?: string },
    page: PageRequest,
  ): Promise<Page<SermonView>> {
    // ARCHIVED is hidden unless explicitly requested.
    const statuses = filter.statuses?.length ? filter.statuses : undefined;
    const effective: SermonFilter = {
      q: filter.q,
      statuses: statuses ?? ALL_VISIBLE_STATUSES,
    };
    return this.query.list(churchId, effective, page);
  }
}

const ALL_VISIBLE_STATUSES: SermonStatus[] = [
  'UPLOADING',
  'UPLOADED',
  'QUEUED',
  'TRANSCRIBING',
  'ANALYZING',
  'INDEXING',
  'READY',
  'FAILED',
];

@Injectable()
export class GetSermonUseCase {
  constructor(@Inject(SERMON_QUERY) private readonly query: SermonQueryPort) {}

  async execute(churchId: string, id: string): Promise<SermonView> {
    const view = await this.query.findView(churchId, id);
    if (!view) throw notFound('Sermon');
    return view;
  }
}

@Injectable()
export class UpdateSermonUseCase {
  constructor(
    @Inject(SERMON_REPOSITORY) private readonly sermons: SermonRepositoryPort,
    @Inject(SERMON_QUERY) private readonly query: SermonQueryPort,
  ) {}

  async execute(
    churchId: string,
    id: string,
    details: SermonDetails,
  ): Promise<SermonView> {
    const sermon = await this.sermons.findById(churchId, id);
    if (!sermon) throw notFound('Sermon');
    sermon.updateDetails(details);
    if (!(await this.sermons.updateDetails(sermon))) throw notFound('Sermon');
    const view = await this.query.findView(churchId, id);
    if (!view) throw notFound('Sermon');
    return view;
  }
}

@Injectable()
export class DeleteSermonUseCase {
  private readonly logger = new Logger(DeleteSermonUseCase.name);

  constructor(
    @Inject(SERMON_REPOSITORY) private readonly sermons: SermonRepositoryPort,
    @Inject(STORAGE) private readonly storage: StoragePort,
  ) {}

  /** Removes the sermon and everything derived from it (transcript, embeddings, content, calendar, files). */
  async execute(churchId: string, id: string): Promise<void> {
    const sermon = await this.sermons.findById(churchId, id);
    if (!sermon) throw notFound('Sermon');
    const assets = await this.sermons.findAssets(churchId, id);
    await this.sermons.delete(churchId, id); // cascades in the database
    // Storage deletes run after the commit; failures leave orphans for the maintenance sweep, never dangling rows.
    for (const asset of assets.filter((stored) => !stored.deletedAt)) {
      await this.storage
        .deleteObject(asset.objectKey)
        .catch((error: unknown) =>
          this.logger.warn(
            { err: error, sermonId: id },
            'Failed to delete sermon asset',
          ),
        );
    }
  }
}

export interface SermonStatusInfo {
  sermonId: string;
  status: SermonStatus;
  processingStage: ProcessingStage | null;
  failedStage: ProcessingStage | null;
  errorMessage: string | null;
  canRetry: boolean;
}

export const toStatusInfo = (sermon: Sermon): SermonStatusInfo => {
  const props = sermon.snapshot();
  return {
    sermonId: props.id,
    status: props.status,
    processingStage: props.status === 'READY' ? null : props.processingStage,
    failedStage: props.status === 'FAILED' ? props.failedStage : null,
    errorMessage: props.status === 'FAILED' ? props.errorMessage : null,
    canRetry: props.status === 'FAILED' && props.canRetry,
  };
};

@Injectable()
export class GetSermonStatusUseCase {
  constructor(
    @Inject(SERMON_REPOSITORY) private readonly sermons: SermonRepositoryPort,
  ) {}

  async execute(churchId: string, id: string): Promise<SermonStatusInfo> {
    const sermon = await this.sermons.findById(churchId, id);
    if (!sermon) throw notFound('Sermon');
    return toStatusInfo(sermon);
  }
}

@Injectable()
export class RetrySermonUseCase {
  constructor(
    @Inject(SERMON_REPOSITORY) private readonly sermons: SermonRepositoryPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(QUEUE) private readonly queue: QueuePort,
  ) {}

  async execute(churchId: string, id: string): Promise<SermonStatusInfo> {
    const sermon = await this.uow.runLocked(`sermon:${id}`, async () => {
      const found = await this.sermons.findById(churchId, id);
      if (!found) throw notFound('Sermon');
      found.retry();
      if (!(await this.sermons.updateForRetry(found))) {
        throw new DomainError(
          'CONFLICT',
          'CANNOT_RETRY',
          'This sermon cannot be retried.',
        );
      }
      return found;
    });
    const payload = {
      churchId,
      sermonId: id,
      attempt: sermon.processingAttempts,
      fromStage: sermon.processingStage ?? 'UPLOAD',
    };
    await this.queue.enqueue(
      SERMON_JOBS.START.queue,
      SERMON_JOBS.START.name,
      payload,
      { jobId: sermonJobId(payload, 'start') },
    );
    return toStatusInfo(sermon);
  }
}

@Injectable()
export class GetTranscriptUseCase {
  constructor(
    @Inject(SERMON_REPOSITORY) private readonly sermons: SermonRepositoryPort,
    @Inject(TRANSCRIPT_REPOSITORY)
    private readonly transcripts: TranscriptRepositoryPort,
  ) {}

  async execute(
    churchId: string,
    id: string,
  ): Promise<TranscriptSegmentRecord[]> {
    const sermon = await this.sermons.findById(churchId, id);
    if (!sermon) throw notFound('Sermon');
    if (!sermon.isReady) throw notReady();
    return this.transcripts.listSegments(churchId, id);
  }
}

@Injectable()
export class GetIntelligenceUseCase {
  constructor(
    @Inject(SERMON_REPOSITORY) private readonly sermons: SermonRepositoryPort,
    @Inject(INTELLIGENCE_REPOSITORY)
    private readonly intelligence: IntelligenceRepositoryPort,
  ) {}

  async execute(churchId: string, id: string): Promise<SermonIntelligence> {
    const sermon = await this.sermons.findById(churchId, id);
    if (!sermon) throw notFound('Sermon');
    if (!sermon.isReady) throw notReady();
    const data = await this.intelligence.find(churchId, id);
    if (!data)
      throw new DomainError(
        'CONFLICT',
        'NOT_READY',
        'Sermon intelligence is not available yet.',
      );
    return data;
  }
}
