import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CACHE,
  type CachePort,
} from '../../../../shared/application/ports/cache.port.js';
import { assertAIBudget } from '../ai-budget.js';
import {
  CHURCH_PROFILE,
  type ChurchProfilePort,
} from '../../../../shared/application/church-profile.js';
import {
  type JobContext,
  PermanentJobError,
} from '../../../../shared/application/jobs.js';
import {
  CLOCK,
  type ClockPort,
} from '../../../../shared/application/ports/clock.port.js';
import { InvalidModelOutputError } from '../../../../shared/application/ports/language-model.port.js';
import {
  QUEUE,
  QUEUES,
  type QueuePort,
} from '../../../../shared/application/ports/queue.port.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '../../../../shared/application/ports/unit-of-work.port.js';
import {
  USAGE_METER,
  type UsageMeterPort,
} from '../../../../shared/application/ports/usage-meter.port.js';
import { notFound, notReady } from '../../../../shared/domain/domain-error.js';
import { newId } from '../../../../shared/domain/id.js';
import { ContentItem } from '../../domain/content-item.entity.js';
import type { ContentType } from '../../domain/content-types.js';
import {
  type GenerationGroupRecord,
  type GenerationJobRecord,
  planGeneration,
} from '../../domain/generation-group.js';
import {
  CONTENT_REPOSITORY,
  type ContentRepositoryPort,
  GENERATION_REPOSITORY,
  type GenerationRepositoryPort,
} from '../ports/out/content-repository.port.js';
import {
  SERMON_CONTEXT,
  type SermonContextPort,
} from '../ports/out/sermon-context.port.js';
import { ContentGenerationService } from '../services/content-generation.service.js';

export interface GenerationJobPayload {
  churchId: string;
  sermonId: string;
  groupId: string;
  jobId: string;
  contentType: ContentType;
}

export const GENERATE_CONTENT_JOB = {
  queue: QUEUES.CONTENT_GENERATION,
  name: 'generate',
} as const;

/** POST /sermons/:id/generate-week — fans out one job per content type (never one giant model call). */
@Injectable()
export class GenerateWeekUseCase {
  constructor(
    @Inject(SERMON_CONTEXT) private readonly sermons: SermonContextPort,
    @Inject(GENERATION_REPOSITORY)
    private readonly generations: GenerationRepositoryPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(QUEUE) private readonly queue: QueuePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(CACHE) private readonly cache: CachePort,
  ) {}

  async execute(
    churchId: string,
    sermonId: string,
    contentTypes: ContentType[],
  ): Promise<GenerationGroupRecord> {
    const status = await this.sermons.findStatus(churchId, sermonId);
    if (!status) throw notFound('Sermon');
    if (status !== 'READY') throw notReady();
    await assertAIBudget(this.cache, churchId, 'generateWeek');

    // Serialised per sermon: concurrent clicks/retries resolve to one group without duplicate jobs.
    const { group, toEnqueue } = await this.uow.runLocked(
      `generation:${sermonId}`,
      async () => {
        const latest = await this.generations.latestGroup(churchId, sermonId);
        const plan = planGeneration(latest, contentTypes);
        const newJob = (
          groupId: string,
          contentType: ContentType,
        ): GenerationJobRecord => ({
          id: newId(),
          groupId,
          churchId,
          sermonId,
          contentType,
          status: 'QUEUED',
          attempts: 0,
          errorMessage: null,
        });
        if (plan.reuse && latest) {
          const requeued = latest.jobs
            .filter((job) => plan.requeue.includes(job.contentType))
            .map((job) => ({
              ...job,
              status: 'QUEUED' as const,
              attempts: 0,
              errorMessage: null,
            }));
          for (const job of requeued) await this.generations.updateJob(job);
          const added = plan.add.map((type) => newJob(latest.id, type));
          await this.generations.addJobs(added);
          const jobs = latest.jobs
            .map(
              (job) =>
                requeued.find((candidate) => candidate.id === job.id) ?? job,
            )
            .concat(added);
          return {
            group: { ...latest, jobs },
            toEnqueue: [...requeued, ...added],
          };
        }
        const created = {
          id: newId(),
          churchId,
          sermonId,
          createdAt: this.clock.now(),
        };
        await this.generations.createGroup(created);
        const jobs = plan.add.map((type) => newJob(created.id, type));
        await this.generations.addJobs(jobs);
        return { group: { ...created, jobs }, toEnqueue: jobs };
      },
    );

    for (const job of toEnqueue) {
      const payload: GenerationJobPayload = {
        churchId,
        sermonId,
        groupId: group.id,
        jobId: job.id,
        contentType: job.contentType,
      };
      // A fresh queue id per (re)queue: the previous failed run may still be retained in Redis for visibility.
      await this.queue.enqueue(
        GENERATE_CONTENT_JOB.queue,
        GENERATE_CONTENT_JOB.name,
        payload,
        { jobId: `generation:${job.id}:${newId()}` },
      );
    }
    return group;
  }
}

@Injectable()
export class GetGenerationGroupUseCase {
  constructor(
    @Inject(GENERATION_REPOSITORY)
    private readonly generations: GenerationRepositoryPort,
  ) {}

  async execute(
    churchId: string,
    sermonId: string,
    groupId: string,
  ): Promise<GenerationGroupRecord> {
    const group = await this.generations.findGroup(churchId, sermonId, groupId);
    if (!group) throw notFound('Generation');
    return group;
  }
}

const userMessageFor = (error: unknown): string => {
  if (error instanceof PermanentJobError && error.userMessage)
    return error.userMessage;
  if (error instanceof InvalidModelOutputError)
    return 'The model returned invalid output.';
  return 'Generation failed. Please retry.';
};

/** Worker: generates one content type for one group. Retry-safe — partial output from earlier attempts is replaced. */
@Injectable()
export class GenerateContentTypeUseCase {
  private readonly logger = new Logger(GenerateContentTypeUseCase.name);

  constructor(
    @Inject(GENERATION_REPOSITORY)
    private readonly generations: GenerationRepositoryPort,
    @Inject(CONTENT_REPOSITORY)
    private readonly contents: ContentRepositoryPort,
    @Inject(SERMON_CONTEXT) private readonly sermons: SermonContextPort,
    @Inject(CHURCH_PROFILE) private readonly profiles: ChurchProfilePort,
    @Inject(ContentGenerationService)
    private readonly generation: ContentGenerationService,
    @Inject(USAGE_METER) private readonly usage: UsageMeterPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(
    payload: GenerationJobPayload,
    context: JobContext,
  ): Promise<void> {
    const job = await this.generations.findJob(payload.churchId, payload.jobId);
    if (!job || job.status === 'COMPLETED') return;
    let generated = 0;
    await this.generations.updateJob({
      ...job,
      status: 'PROCESSING',
      attempts: context.attempt,
      errorMessage: null,
    });
    try {
      const sermon = await this.sermons.load(
        payload.churchId,
        payload.sermonId,
      );
      if (!sermon || sermon.status !== 'READY')
        throw new PermanentJobError(
          'Sermon unavailable',
          'This sermon is no longer available.',
        );
      const output = await this.generation.generate(
        job.contentType,
        sermon,
        await this.profiles.findAIProfile(payload.churchId),
        undefined,
        [],
        context.signal,
      );
      if (output.pieces.length === 0) {
        throw new PermanentJobError(
          'Nothing generated',
          job.contentType === 'QUOTE'
            ? 'No exact quotes could be found in this sermon.'
            : undefined,
        );
      }
      const now = this.clock.now();
      const items = output.pieces.map((piece) =>
        ContentItem.generate({
          id: newId(),
          churchId: payload.churchId,
          sermonId: payload.sermonId,
          generationJobId: job.id,
          type: job.contentType,
          position: piece.position,
          title: piece.title,
          body: piece.body,
          scripture: piece.scripture,
          sourceMetadata: piece.sourceMetadata,
          ai: output.ai,
          now,
        }),
      );
      await this.uow.run(async () => {
        await this.contents.deleteByGenerationJob(payload.churchId, job.id);
        await this.contents.saveMany(items);
        await this.generations.updateJob({
          ...job,
          status: 'COMPLETED',
          attempts: context.attempt,
          errorMessage: null,
        });
      });
      generated = items.length;
    } catch (error) {
      const final =
        error instanceof PermanentJobError || context.isFinalAttempt;
      await this.generations.updateJob({
        ...job,
        status: final ? 'FAILED' : 'RETRYING',
        attempts: context.attempt,
        errorMessage: final ? userMessageFor(error) : null,
      });
      this.logger.warn(
        { jobId: job.id, contentType: job.contentType, final, err: error },
        'Content generation attempt failed',
      );
      throw error;
    }
    // The content is committed and the job is COMPLETED. Metering runs outside the try above so a
    // metering failure can never flip the job back to retrying (a retry would delete the delivered
    // items). The dedupe key keeps the count right if this is ever repeated.
    await this.usage
      .record({
        churchId: payload.churchId,
        unit: 'CONTENT_GENERATED',
        quantity: generated,
        sermonId: payload.sermonId,
        dedupeKey: `generation:${job.id}`,
      })
      .catch((error: unknown) =>
        this.logger.error(
          { jobId: job.id, err: error },
          'Failed to record generation usage',
        ),
      );
  }
}
