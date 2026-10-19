import { join } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CHURCH_PROFILE, type ChurchProfilePort } from '../../shared/application/church-profile.js';
import { defineJobHandler, JOB_HANDLER_REGISTRY, type JobContext, type JobHandlerRegistry, PermanentJobError } from '../../shared/application/jobs.js';
import { CLOCK, type ClockPort } from '../../shared/application/ports/clock.port.js';
import { LANGUAGE_MODEL, type LanguageModelPort } from '../../shared/application/ports/language-model.port.js';
import { QUEUE, type QueuePort } from '../../shared/application/ports/queue.port.js';
import { STORAGE, type StoragePort } from '../../shared/application/ports/storage.port.js';
import { UNIT_OF_WORK, type UnitOfWorkPort } from '../../shared/application/ports/unit-of-work.port.js';
import { USAGE_METER, type UsageMeterPort } from '../../shared/application/ports/usage-meter.port.js';
import { newId } from '../../shared/domain/id.js';
import { SermonAnalysisService } from './adapters/sermon-analysis.js';
import {
  DOCUMENT_TEXT_EXTRACTOR, type DocumentTextExtractorPort, MEDIA_PROCESSOR, type MediaProcessorPort, SCRATCH_SPACE,
  type ScratchSpacePort, TRANSCRIPTION, type TranscriptionPort,
} from './adapters/ports.js';
import { mediaKindOf } from '../uploads/helper.js';
import {
  EMBEDDING_BATCH_SIZE, MIN_PIPELINE_WORDS, PHASE_JOBS, phaseForStage, type PipelinePhase, type ProcessingStage,
  PURGE_EXPIRED_SOURCES_EVERY_MS, PURGE_EXPIRED_SOURCES_JOB, RECOVER_STUCK_SERMONS_EVERY_MS, RECOVER_STUCK_SERMONS_JOB,
  type Sermon, SERMON_JOBS, type SermonJobPayload, sermonJobId, SermonSupersededError, segmentTranscript,
  STAGE_FAILURE_MESSAGES, totalWords, type TranscriptFragment,
} from './helper.js';
import {
  EMBEDDING_REPOSITORY, type EmbeddingRepositoryPort, type EmbeddingRow, INTELLIGENCE_REPOSITORY,
  type IntelligenceRepositoryPort, SERMON_REPOSITORY, type SermonRepositoryPort, TRANSCRIPT_REPOSITORY,
  type TranscriptRepositoryPort,
} from './sermons.repository.js';
import { SermonsService } from './sermons.service.js';

/** The processing pipeline: start → transcribe → analyse → index, each phase retried independently. */
@Injectable()
export class PipelineService implements OnModuleInit {
  private readonly logger = new Logger(PipelineService.name);

  constructor(
    @Inject(SERMON_REPOSITORY) private readonly sermons: SermonRepositoryPort,
    @Inject(TRANSCRIPT_REPOSITORY) private readonly transcripts: TranscriptRepositoryPort,
    @Inject(INTELLIGENCE_REPOSITORY) private readonly intelligence: IntelligenceRepositoryPort,
    @Inject(EMBEDDING_REPOSITORY) private readonly embeddings: EmbeddingRepositoryPort,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(MEDIA_PROCESSOR) private readonly media: MediaProcessorPort,
    @Inject(TRANSCRIPTION) private readonly transcription: TranscriptionPort,
    @Inject(DOCUMENT_TEXT_EXTRACTOR) private readonly documents: DocumentTextExtractorPort,
    @Inject(SCRATCH_SPACE) private readonly scratch: ScratchSpacePort,
    @Inject(SermonAnalysisService) private readonly analysis: SermonAnalysisService,
    @Inject(CHURCH_PROFILE) private readonly profiles: ChurchProfilePort,
    @Inject(LANGUAGE_MODEL) private readonly model: LanguageModelPort,
    @Inject(USAGE_METER) private readonly usage: UsageMeterPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(QUEUE) private readonly queue: QueuePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(SermonsService) private readonly sermonsService: SermonsService,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(defineJobHandler<SermonJobPayload>(SERMON_JOBS.START, (p, c) => this.start(p, c)));
    this.registry.register(defineJobHandler<SermonJobPayload>(SERMON_JOBS.TRANSCRIBE, (p, c) => this.transcribe(p, c)));
    this.registry.register(defineJobHandler<SermonJobPayload>(SERMON_JOBS.ANALYZE, (p, c) => this.analyze(p, c)));
    this.registry.register(defineJobHandler<SermonJobPayload>(SERMON_JOBS.INDEX, (p, c) => this.index(p, c)));
    this.registry.register(
      defineJobHandler(RECOVER_STUCK_SERMONS_JOB, async (_payload, context) => void (await this.sermonsService.recoverStuck(context))),
    );
    this.registry.registerRecurring({
      queue: RECOVER_STUCK_SERMONS_JOB.queue,
      jobName: RECOVER_STUCK_SERMONS_JOB.name,
      everyMs: RECOVER_STUCK_SERMONS_EVERY_MS,
    });
    this.registry.register(
      defineJobHandler(PURGE_EXPIRED_SOURCES_JOB, async (_payload, context) => void (await this.sermonsService.purgeExpiredSources(context))),
    );
    this.registry.registerRecurring({
      queue: PURGE_EXPIRED_SOURCES_JOB.queue,
      jobName: PURGE_EXPIRED_SOURCES_JOB.name,
      everyMs: PURGE_EXPIRED_SOURCES_EVERY_MS,
    });
  }

  // ───────────── Phases ─────────────

  /** Entry point for a new run or a retry: routes to the phase containing the resume stage. */
  private async start(payload: SermonJobPayload, context: JobContext): Promise<void> {
    await this.run(payload, context, async () => {
      await this.enqueuePhase(payload, phaseForStage(payload.fromStage ?? 'UPLOAD'));
    });
  }

  /** Stages MEDIA + TRANSCRIBE: produce a segmented transcript from media, a document or pasted text. */
  private async transcribe(payload: SermonJobPayload, context: JobContext): Promise<void> {
    await this.run(payload, context, async (sermon) => {
      // Idempotent: a previous attempt may have finished transcription before crashing.
      if ((await this.transcripts.countSegments(payload.churchId, payload.sermonId)) === 0) {
        await this.enterStage(sermon, 'MEDIA');
        const { fragments, provider, language, durationMs } = await this.fetchTranscript(sermon, payload, context.signal);
        const segments = segmentTranscript(fragments);
        if (totalWords(segments) < MIN_PIPELINE_WORDS) {
          throw new PermanentJobError(
            'Transcript too short',
            'We could not find enough spoken words in this sermon to continue.',
          );
        }
        if (durationMs !== null) sermon.recordDuration(durationMs);
        await this.uow.run(async () => {
          await this.transcripts.replace({
            churchId: payload.churchId,
            sermonId: payload.sermonId,
            transcriptId: newId(),
            fullText: segments.map((segment) => segment.text).join('\n\n'),
            language,
            provider,
            segments: segments.map((segment) => ({ ...segment, id: newId() })),
          });
          await this.persist(sermon);
        });
        if (durationMs !== null) {
          await this.usage.record({
            churchId: payload.churchId,
            unit: 'TRANSCRIPTION_MINUTE',
            quantity: Math.ceil(durationMs / 60_000),
            sermonId: payload.sermonId,
            dedupeKey: `transcription:${payload.sermonId}:${payload.attempt}`,
          });
        }
      }
      await this.enterStage(sermon, 'UNDERSTAND');
      await this.enqueuePhase(payload, 'ANALYSIS');
    });
  }

  /** Stages UNDERSTAND + SCRIPTURES + INTELLIGENCE. */
  private async analyze(payload: SermonJobPayload, context: JobContext): Promise<void> {
    await this.run(payload, context, async (sermon) => {
      await this.enterStage(sermon, 'UNDERSTAND');
      const segments = await this.transcripts.listSegments(payload.churchId, payload.sermonId);
      if (segments.length === 0) throw new PermanentJobError('No transcript segments');
      const props = sermon.snapshot();
      const result = await this.analysis.analyze({
        churchId: payload.churchId,
        sermonId: payload.sermonId,
        title: props.title,
        speaker: props.speaker,
        mainScripture: props.mainScripture,
        segments,
        profile: await this.profiles.findAIProfile(payload.churchId),
        signal: context.signal,
      });
      await this.enterStage(sermon, 'SCRIPTURES');
      await this.intelligence.replaceScriptures(payload.churchId, payload.sermonId, result.scriptureReferences);
      await this.enterStage(sermon, 'INTELLIGENCE');
      const { intelligence } = result;
      await this.uow.run(async () => {
        await this.intelligence.upsert({
          id: newId(),
          churchId: payload.churchId,
          sermonId: payload.sermonId,
          data: intelligence,
          aiProvider: result.provider,
          aiModel: result.model,
        });
        sermon.applyAnalysis({
          summary: intelligence.summary,
          mainTheme: intelligence.mainTheme.text,
          themes: [intelligence.mainTheme.text, ...intelligence.secondaryThemes.map((theme) => theme.text)],
          scriptures: intelligence.scriptures,
        });
        sermon.enterStage('INDEX');
        await this.persist(sermon);
      });
      await this.enqueuePhase(payload, 'INDEXING');
    });
  }

  /** Stage INDEX: embed every transcript segment, then mark the sermon READY. */
  private async index(payload: SermonJobPayload, context: JobContext): Promise<void> {
    await this.run(payload, context, async (sermon) => {
      await this.enterStage(sermon, 'INDEX');
      const segments = await this.transcripts.listSegments(payload.churchId, payload.sermonId);
      const title = sermon.title;
      const rows: EmbeddingRow[] = [];
      for (let start = 0; start < segments.length; start += EMBEDDING_BATCH_SIZE) {
        const batch = segments.slice(start, start + EMBEDDING_BATCH_SIZE);
        const { vectors } = await this.model.embed({
          context: { operation: 'sermon.embed', churchId: payload.churchId, sermonId: payload.sermonId },
          inputs: batch.map((segment) => `${title}\n\n${segment.text}`),
          signal: context.signal,
        });
        batch.forEach((segment, index) => {
          const embedding = vectors[index];
          if (!embedding) throw new Error('Embedding count mismatch');
          rows.push({
            id: newId(),
            churchId: payload.churchId,
            sermonId: payload.sermonId,
            transcriptSegmentId: segment.id,
            content: segment.text,
            embedding,
            metadata: { sequence: segment.sequence, startTimeMs: segment.startTimeMs, endTimeMs: segment.endTimeMs },
          });
        });
      }
      await this.uow.run(async () => {
        await this.embeddings.replaceForSermon(payload.churchId, payload.sermonId, rows);
        sermon.markReady(this.clock.now());
        await this.persist(sermon);
      });
    });
  }

  // ───────────── Shared guard + failure policy ─────────────

  /** Loads the sermon if this job still belongs to its current processing run. */
  private async load(payload: SermonJobPayload): Promise<Sermon | null> {
    const sermon = await this.sermons.findById(payload.churchId, payload.sermonId);
    if (!sermon || !sermon.acceptsJobFor(payload.attempt)) {
      this.logger.log({ sermonId: payload.sermonId, attempt: payload.attempt }, 'Skipping stale or completed sermon job');
      return null;
    }
    return sermon;
  }

  /** Saves processing state; aborts the job if the sermon was deleted, finished or retried meanwhile. */
  private async persist(sermon: Sermon): Promise<void> {
    if (!(await this.sermons.updateProcessing(sermon))) throw new SermonSupersededError(sermon.id);
  }

  private async enterStage(sermon: Sermon, stage: ProcessingStage): Promise<void> {
    sermon.enterStage(stage);
    await this.persist(sermon);
  }

  private async enqueuePhase(payload: SermonJobPayload, phase: PipelinePhase): Promise<void> {
    const job = PHASE_JOBS[phase];
    const next: SermonJobPayload = {
      churchId: payload.churchId,
      sermonId: payload.sermonId,
      attempt: payload.attempt,
    };
    await this.queue.enqueue(job.queue, job.name, next, { jobId: sermonJobId(next, phase) });
  }

  /**
   * Runs a phase. Transient errors are rethrown for queue retry; on the final attempt (or a permanent
   * error) the sermon is marked FAILED at the stage it reached, with a user-safe message.
   */
  private async run(payload: SermonJobPayload, context: JobContext, work: (sermon: Sermon) => Promise<void>): Promise<void> {
    const sermon = await this.load(payload);
    if (!sermon) return;
    try {
      await work(sermon);
    } catch (error) {
      if (error instanceof SermonSupersededError) {
        // Deleted, retried or already finished elsewhere: nothing to do and nothing to retry.
        this.logger.log({ sermonId: payload.sermonId, attempt: payload.attempt }, 'Sermon job superseded; stopping');
        return;
      }
      const permanent = error instanceof PermanentJobError;
      if (permanent || context.isFinalAttempt) {
        const stage = sermon.processingStage ?? 'UPLOAD';
        const fresh = await this.sermons.findById(payload.churchId, payload.sermonId);
        if (fresh && fresh.acceptsJobFor(payload.attempt)) {
          fresh.markFailed(stage, (permanent && error.userMessage) || STAGE_FAILURE_MESSAGES[stage], true);
          await this.sermons.updateProcessing(fresh);
        }
        this.logger.warn({ sermonId: payload.sermonId, stage, err: error }, 'Sermon processing failed');
      }
      throw error;
    }
  }

  // ───────────── Source → transcript fragments ─────────────

  private async fetchTranscript(
    sermon: Sermon,
    payload: SermonJobPayload,
    signal: AbortSignal,
  ): Promise<{ fragments: TranscriptFragment[]; provider: string; language: string | null; durationMs: number | null }> {
    if (sermon.sourceType === 'TEXT') {
      const text = await this.transcripts.findSourceText(payload.churchId, payload.sermonId);
      if (!text) throw new PermanentJobError('Pasted transcript missing');
      await this.enterStage(sermon, 'TRANSCRIBE');
      return { fragments: [{ text }], provider: 'pasted', language: null, durationMs: null };
    }
    const [asset] = await this.sermons.findAssets(payload.churchId, payload.sermonId);
    if (!asset) throw new PermanentJobError('Sermon asset missing');
    const kind = mediaKindOf('SERMON_MEDIA', asset.contentType);

    return this.scratch.withDirectory(async (dir) => {
      const sourcePath = join(dir, `source.${asset.objectKey.split('.').pop() ?? 'bin'}`);
      // The object was validated when the sermon was created; refuse it if it has changed since.
      const stored = await this.storage.headObject(asset.objectKey);
      if (!stored || stored.sizeBytes !== asset.sizeBytes) {
        throw new PermanentJobError(
          'Stored object missing or changed since validation',
          'We could not read this file. Please upload it again.',
        );
      }
      await this.storage.downloadToFile(asset.objectKey, sourcePath, signal);
      if (kind === 'PDF' || kind === 'DOCX' || kind === 'TEXT') {
        const text = await this.documents.extract(sourcePath, kind);
        await this.enterStage(sermon, 'TRANSCRIBE');
        return { fragments: [{ text }], provider: `document:${kind.toLowerCase()}`, language: null, durationMs: null };
      }
      const prepared = await this.media.prepareForTranscription(sourcePath, dir, signal);
      await this.enterStage(sermon, 'TRANSCRIBE');
      const fragments: TranscriptFragment[] = [];
      let provider = 'unknown';
      let language: string | null = null;
      // Chunks are transcribed sequentially to bound memory and provider concurrency.
      for (const chunk of prepared.chunks) {
        const result = await this.transcription.transcribe({
          filePath: chunk.path,
          durationMs: chunk.durationMs,
          signal,
          context: { churchId: payload.churchId, sermonId: payload.sermonId },
        });
        provider = result.provider;
        language ??= result.language;
        for (const fragment of result.fragments) {
          fragments.push({
            text: fragment.text,
            startMs: fragment.startMs + chunk.offsetMs,
            endMs: fragment.endMs + chunk.offsetMs,
            words: fragment.words?.map((word) => ({
              text: word.text,
              startMs: word.startMs + chunk.offsetMs,
              endMs: word.endMs + chunk.offsetMs,
            })),
          });
        }
      }
      return { fragments, provider, language, durationMs: prepared.durationMs };
    });
  }
}
