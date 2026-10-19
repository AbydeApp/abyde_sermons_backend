import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { assertAIBudget } from '../../shared/application/ai-budget.js';
import { CHURCH_PROFILE, type ChurchProfilePort } from '../../shared/application/church-profile.js';
import {
  checkpoint, defineJobHandler, JOB_HANDLER_REGISTRY, type JobContext, type JobHandlerRegistry, PermanentJobError,
  type RunGuard,
} from '../../shared/application/jobs.js';
import { CACHE, type CachePort } from '../../shared/application/ports/cache.port.js';
import { CLOCK, type ClockPort } from '../../shared/application/ports/clock.port.js';
import { QUEUE, type QueuePort } from '../../shared/application/ports/queue.port.js';
import { UNIT_OF_WORK, type UnitOfWorkPort } from '../../shared/application/ports/unit-of-work.port.js';
import { USAGE_METER, type UsageMeterPort } from '../../shared/application/ports/usage-meter.port.js';
import { notFound, notReady } from '../../shared/domain/domain-error.js';
import { newId } from '../../shared/domain/id.js';
import { ContentGenerationService } from './adapters/content-generator.js';
import { SERMON_CONTEXT, type SermonContextPort } from './adapters/sermon-context.adapter.js';
import {
  CONTENT_REPOSITORY, type ContentRepositoryPort, GENERATION_REPOSITORY, type GenerationRepositoryPort,
} from './content.repository.js';
import {
  ContentItem, type ContentType, GENERATE_CONTENT_JOB, generationLockKey, type GenerationGroupRecord,
  type GenerationJobPayload, type GenerationJobRecord, planGeneration, RECOVER_GENERATIONS_EVERY_MS,
  RECOVER_STUCK_GENERATIONS_JOB, STUCK_GENERATION_AFTER_MS, STUCK_GENERATION_MESSAGE, userMessageFor,
} from './helper.js';

/** "Generate My Week": fans out one job per content type, and the worker that runs each one. */
@Injectable()
export class GenerationService implements OnModuleInit {
  private readonly logger = new Logger(GenerationService.name);

  constructor(
    @Inject(GENERATION_REPOSITORY) private readonly generations: GenerationRepositoryPort,
    @Inject(CONTENT_REPOSITORY) private readonly contents: ContentRepositoryPort,
    @Inject(SERMON_CONTEXT) private readonly sermons: SermonContextPort,
    @Inject(CHURCH_PROFILE) private readonly profiles: ChurchProfilePort,
    @Inject(ContentGenerationService) private readonly generator: ContentGenerationService,
    @Inject(USAGE_METER) private readonly usage: UsageMeterPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(QUEUE) private readonly queue: QueuePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      defineJobHandler<GenerationJobPayload>(GENERATE_CONTENT_JOB, (payload, context) =>
        this.generateType(payload, context),
      ),
    );
    this.registry.register(
      defineJobHandler(
        RECOVER_STUCK_GENERATIONS_JOB,
        async (_payload, context) => void (await this.recoverStuck(context)),
      ),
    );
    this.registry.registerRecurring({
      queue: RECOVER_STUCK_GENERATIONS_JOB.queue,
      jobName: RECOVER_STUCK_GENERATIONS_JOB.name,
      everyMs: RECOVER_GENERATIONS_EVERY_MS,
    });
  }

  // ───────────── API side ─────────────

  async generateWeek(churchId: string, sermonId: string, contentTypes: ContentType[]): Promise<GenerationGroupRecord> {
    const status = await this.sermons.findStatus(churchId, sermonId);
    if (!status) throw notFound('Sermon');
    if (status !== 'READY') throw notReady();
    await assertAIBudget(this.cache, churchId, 'generateWeek');

    // Serialised per sermon: concurrent clicks/retries resolve to one group without duplicate jobs.
    const { group, toEnqueue } = await this.uow.runLocked(generationLockKey(sermonId), async () => {
      const latest = await this.generations.latestGroup(churchId, sermonId);
      const plan = planGeneration(latest, contentTypes);
      const newJob = (groupId: string, contentType: ContentType): GenerationJobRecord => ({
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
          .map((job) => ({ ...job, status: 'QUEUED' as const, attempts: 0, errorMessage: null }));
        for (const job of requeued) await this.generations.updateJob(job);
        const added = plan.add.map((type) => newJob(latest.id, type));
        await this.generations.addJobs(added);
        const jobs = latest.jobs
          .map((job) => requeued.find((candidate) => candidate.id === job.id) ?? job)
          .concat(added);
        return { group: { ...latest, jobs }, toEnqueue: [...requeued, ...added] };
      }
      const created = { id: newId(), churchId, sermonId, createdAt: this.clock.now() };
      await this.generations.createGroup(created);
      const jobs = plan.add.map((type) => newJob(created.id, type));
      await this.generations.addJobs(jobs);
      return { group: { ...created, jobs }, toEnqueue: jobs };
    });

    for (const job of toEnqueue) {
      const payload: GenerationJobPayload = {
        churchId,
        sermonId,
        groupId: group.id,
        jobId: job.id,
        contentType: job.contentType,
      };
      // A fresh queue id per (re)queue: the previous failed run may still be retained in Redis for visibility.
      await this.queue.enqueue(GENERATE_CONTENT_JOB.queue, GENERATE_CONTENT_JOB.name, payload, {
        jobId: `generation:${job.id}:${newId()}`,
      });
    }
    return group;
  }

  async getGroup(churchId: string, sermonId: string, groupId: string): Promise<GenerationGroupRecord> {
    const group = await this.generations.findGroup(churchId, sermonId, groupId);
    if (!group) throw notFound('Generation');
    return group;
  }

  // ───────────── Worker side ─────────────

  /** Generates one content type for one group. Retry-safe: partial output from earlier attempts is replaced. */
  private async generateType(payload: GenerationJobPayload, context: JobContext): Promise<void> {
    const job = await this.generations.findJob(payload.churchId, payload.jobId);
    if (!job || job.status === 'COMPLETED') return;
    let generated = 0;
    await this.generations.updateJob({ ...job, status: 'PROCESSING', attempts: context.attempt, errorMessage: null });
    try {
      const sermon = await this.sermons.load(payload.churchId, payload.sermonId);
      if (!sermon || sermon.status !== 'READY')
        throw new PermanentJobError('Sermon unavailable', 'This sermon is no longer available.');
      const output = await this.generator.generate(
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
          job.contentType === 'QUOTE' ? 'No exact quotes could be found in this sermon.' : undefined,
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
        await this.generations.updateJob({ ...job, status: 'COMPLETED', attempts: context.attempt, errorMessage: null });
      });
      generated = items.length;
    } catch (error) {
      const final = error instanceof PermanentJobError || context.isFinalAttempt;
      await this.generations.updateJob({
        ...job,
        status: final ? 'FAILED' : 'RETRYING',
        attempts: context.attempt,
        errorMessage: final ? userMessageFor(error) : null,
      });
      this.logger.warn({ jobId: job.id, contentType: job.contentType, final, err: error }, 'Content generation attempt failed');
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
      .catch((error: unknown) => this.logger.error({ jobId: job.id, err: error }, 'Failed to record generation usage'));
  }

  /**
   * Maintenance: fails generation jobs left QUEUED/PROCESSING/RETRYING with no queue job behind them
   * (worker killed, or queue unavailable at enqueue time), so the group reaches `done` and the web app
   * can offer "Retry failed".
   */
  async recoverStuck(guard?: RunGuard): Promise<number> {
    await checkpoint(guard);
    const cutoff = new Date(this.clock.now().getTime() - STUCK_GENERATION_AFTER_MS);
    const failed = await this.generations.failStale(cutoff, STUCK_GENERATION_MESSAGE);
    if (failed > 0) this.logger.warn({ failed }, 'Marked stuck generation jobs as failed');
    return failed;
  }
}
