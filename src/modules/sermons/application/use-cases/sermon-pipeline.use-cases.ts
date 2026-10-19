import { Inject, Injectable, Logger } from '@nestjs/common';
import { join } from 'node:path';
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
import {
  LANGUAGE_MODEL,
  type LanguageModelPort,
} from '../../../../shared/application/ports/language-model.port.js';
import {
  QUEUE,
  type QueuePort,
} from '../../../../shared/application/ports/queue.port.js';
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
import { newId } from '../../../../shared/domain/id.js';
import { mediaKindOf } from '../../../uploads/helper.js';
import {
  phaseForStage,
  type PipelinePhase,
  type ProcessingStage,
  STAGE_FAILURE_MESSAGES,
} from '../../domain/processing.js';
import type { Sermon } from '../../domain/sermon.entity.js';
import {
  segmentTranscript,
  totalWords,
  type TranscriptFragment,
} from '../../domain/transcript-segmenter.js';
import {
  DOCUMENT_TEXT_EXTRACTOR,
  type DocumentTextExtractorPort,
  MEDIA_PROCESSOR,
  type MediaProcessorPort,
  SCRATCH_SPACE,
  type ScratchSpacePort,
  TRANSCRIPTION,
  type TranscriptionPort,
} from '../ports/out/processing.ports.js';
import {
  SERMON_REPOSITORY,
  type SermonRepositoryPort,
} from '../ports/out/sermon-repository.port.js';
import {
  EMBEDDING_REPOSITORY,
  type EmbeddingRepositoryPort,
  type EmbeddingRow,
  INTELLIGENCE_REPOSITORY,
  type IntelligenceRepositoryPort,
  TRANSCRIPT_REPOSITORY,
  type TranscriptRepositoryPort,
} from '../ports/out/transcript-repository.port.js';
import { SermonAnalysisService } from '../services/sermon-analysis.service.js';
import {
  PHASE_JOBS,
  type SermonJobPayload,
  sermonJobId,
} from '../sermon-jobs.js';

const MIN_WORDS = 50;
const EMBEDDING_BATCH_SIZE = 64;

/** The stored sermon no longer belongs to this job's processing run. */
export class SermonSupersededError extends Error {
  constructor(sermonId: string) {
    super(
      `Sermon ${sermonId} was deleted, finished or retried while this job was running`,
    );
    this.name = 'SermonSupersededError';
  }
}

/** Shared guard + failure policy for every pipeline phase. */
@Injectable()
export class SermonPipelineSupport {
  private readonly logger = new Logger(SermonPipelineSupport.name);

  constructor(
    @Inject(SERMON_REPOSITORY) private readonly sermons: SermonRepositoryPort,
    @Inject(QUEUE) private readonly queue: QueuePort,
  ) {}

  /** Loads the sermon if this job still belongs to its current processing run. */
  async load(payload: SermonJobPayload): Promise<Sermon | null> {
    const sermon = await this.sermons.findById(
      payload.churchId,
      payload.sermonId,
    );
    if (!sermon || !sermon.acceptsJobFor(payload.attempt)) {
      this.logger.log(
        { sermonId: payload.sermonId, attempt: payload.attempt },
        'Skipping stale or completed sermon job',
      );
      return null;
    }
    return sermon;
  }

  /** Saves processing state; aborts the job if the sermon was deleted, finished or retried meanwhile. */
  async persist(sermon: Sermon): Promise<void> {
    if (!(await this.sermons.updateProcessing(sermon)))
      throw new SermonSupersededError(sermon.id);
  }

  async enterStage(sermon: Sermon, stage: ProcessingStage): Promise<void> {
    sermon.enterStage(stage);
    await this.persist(sermon);
  }

  async enqueuePhase(
    payload: SermonJobPayload,
    phase: PipelinePhase,
  ): Promise<void> {
    const job = PHASE_JOBS[phase];
    const next: SermonJobPayload = {
      churchId: payload.churchId,
      sermonId: payload.sermonId,
      attempt: payload.attempt,
    };
    await this.queue.enqueue(job.queue, job.name, next, {
      jobId: sermonJobId(next, phase),
    });
  }

  /**
   * Runs a phase. Transient errors are rethrown for queue retry; on the final attempt (or a permanent
   * error) the sermon is marked FAILED at the stage it reached, with a user-safe message.
   */
  async run(
    payload: SermonJobPayload,
    context: JobContext,
    work: (sermon: Sermon) => Promise<void>,
  ): Promise<void> {
    const sermon = await this.load(payload);
    if (!sermon) return;
    try {
      await work(sermon);
    } catch (error) {
      if (error instanceof SermonSupersededError) {
        // Deleted, retried or already finished elsewhere: nothing to do and nothing to retry.
        this.logger.log(
          { sermonId: payload.sermonId, attempt: payload.attempt },
          'Sermon job superseded; stopping',
        );
        return;
      }
      const permanent = error instanceof PermanentJobError;
      if (permanent || context.isFinalAttempt) {
        const stage = sermon.processingStage ?? 'UPLOAD';
        const fresh = await this.sermons.findById(
          payload.churchId,
          payload.sermonId,
        );
        if (fresh && fresh.acceptsJobFor(payload.attempt)) {
          fresh.markFailed(
            stage,
            (permanent && error.userMessage) || STAGE_FAILURE_MESSAGES[stage],
            true,
          );
          await this.sermons.updateProcessing(fresh);
        }
        this.logger.warn(
          { sermonId: payload.sermonId, stage, err: error },
          'Sermon processing failed',
        );
      }
      throw error;
    }
  }
}

/** Entry point for a new run or a retry: routes to the phase containing the resume stage. */
@Injectable()
export class StartSermonProcessingUseCase {
  constructor(
    @Inject(SermonPipelineSupport)
    private readonly pipeline: SermonPipelineSupport,
  ) {}

  async execute(payload: SermonJobPayload, context: JobContext): Promise<void> {
    await this.pipeline.run(payload, context, async () => {
      await this.pipeline.enqueuePhase(
        payload,
        phaseForStage(payload.fromStage ?? 'UPLOAD'),
      );
    });
  }
}

/** Stages MEDIA + TRANSCRIBE: produce a segmented transcript from media, a document or pasted text. */
@Injectable()
export class TranscribeSermonUseCase {
  constructor(
    @Inject(SermonPipelineSupport)
    private readonly pipeline: SermonPipelineSupport,
    @Inject(SERMON_REPOSITORY) private readonly sermons: SermonRepositoryPort,
    @Inject(TRANSCRIPT_REPOSITORY)
    private readonly transcripts: TranscriptRepositoryPort,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(MEDIA_PROCESSOR) private readonly media: MediaProcessorPort,
    @Inject(TRANSCRIPTION) private readonly transcription: TranscriptionPort,
    @Inject(DOCUMENT_TEXT_EXTRACTOR)
    private readonly documents: DocumentTextExtractorPort,
    @Inject(SCRATCH_SPACE) private readonly scratch: ScratchSpacePort,
    @Inject(USAGE_METER) private readonly usage: UsageMeterPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
  ) {}

  async execute(payload: SermonJobPayload, context: JobContext): Promise<void> {
    await this.pipeline.run(payload, context, async (sermon) => {
      // Idempotent: a previous attempt may have finished transcription before crashing.
      if (
        (await this.transcripts.countSegments(
          payload.churchId,
          payload.sermonId,
        )) === 0
      ) {
        await this.pipeline.enterStage(sermon, 'MEDIA');
        const { fragments, provider, language, durationMs } =
          await this.transcribe(sermon, payload, context.signal);
        const segments = segmentTranscript(fragments);
        if (totalWords(segments) < MIN_WORDS) {
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
          await this.pipeline.persist(sermon);
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
      await this.pipeline.enterStage(sermon, 'UNDERSTAND');
      await this.pipeline.enqueuePhase(payload, 'ANALYSIS');
    });
  }

  private async transcribe(
    sermon: Sermon,
    payload: SermonJobPayload,
    signal: AbortSignal,
  ): Promise<{
    fragments: TranscriptFragment[];
    provider: string;
    language: string | null;
    durationMs: number | null;
  }> {
    if (sermon.sourceType === 'TEXT') {
      const text = await this.transcripts.findSourceText(
        payload.churchId,
        payload.sermonId,
      );
      if (!text) throw new PermanentJobError('Pasted transcript missing');
      await this.pipeline.enterStage(sermon, 'TRANSCRIBE');
      return {
        fragments: [{ text }],
        provider: 'pasted',
        language: null,
        durationMs: null,
      };
    }
    const [asset] = await this.sermons.findAssets(
      payload.churchId,
      payload.sermonId,
    );
    if (!asset) throw new PermanentJobError('Sermon asset missing');
    const kind = mediaKindOf('SERMON_MEDIA', asset.contentType);

    return this.scratch.withDirectory(async (dir) => {
      const sourcePath = join(
        dir,
        `source.${asset.objectKey.split('.').pop() ?? 'bin'}`,
      );
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
        await this.pipeline.enterStage(sermon, 'TRANSCRIBE');
        return {
          fragments: [{ text }],
          provider: `document:${kind.toLowerCase()}`,
          language: null,
          durationMs: null,
        };
      }
      const prepared = await this.media.prepareForTranscription(
        sourcePath,
        dir,
        signal,
      );
      await this.pipeline.enterStage(sermon, 'TRANSCRIBE');
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

/** Stages UNDERSTAND + SCRIPTURES + INTELLIGENCE. */
@Injectable()
export class AnalyzeSermonUseCase {
  constructor(
    @Inject(SermonPipelineSupport)
    private readonly pipeline: SermonPipelineSupport,
    @Inject(SERMON_REPOSITORY) private readonly sermons: SermonRepositoryPort,
    @Inject(TRANSCRIPT_REPOSITORY)
    private readonly transcripts: TranscriptRepositoryPort,
    @Inject(INTELLIGENCE_REPOSITORY)
    private readonly intelligence: IntelligenceRepositoryPort,
    @Inject(CHURCH_PROFILE) private readonly profiles: ChurchProfilePort,
    @Inject(SermonAnalysisService)
    private readonly analysis: SermonAnalysisService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
  ) {}

  async execute(payload: SermonJobPayload, context: JobContext): Promise<void> {
    await this.pipeline.run(payload, context, async (sermon) => {
      await this.pipeline.enterStage(sermon, 'UNDERSTAND');
      const segments = await this.transcripts.listSegments(
        payload.churchId,
        payload.sermonId,
      );
      if (segments.length === 0)
        throw new PermanentJobError('No transcript segments');
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
      await this.pipeline.enterStage(sermon, 'SCRIPTURES');
      await this.intelligence.replaceScriptures(
        payload.churchId,
        payload.sermonId,
        result.scriptureReferences,
      );
      await this.pipeline.enterStage(sermon, 'INTELLIGENCE');
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
          themes: [
            intelligence.mainTheme.text,
            ...intelligence.secondaryThemes.map((theme) => theme.text),
          ],
          scriptures: intelligence.scriptures,
        });
        sermon.enterStage('INDEX');
        await this.pipeline.persist(sermon);
      });
      await this.pipeline.enqueuePhase(payload, 'INDEXING');
    });
  }
}

/** Stage INDEX: embed every transcript segment, then mark the sermon READY. */
@Injectable()
export class IndexSermonUseCase {
  constructor(
    @Inject(SermonPipelineSupport)
    private readonly pipeline: SermonPipelineSupport,
    @Inject(SERMON_REPOSITORY) private readonly sermons: SermonRepositoryPort,
    @Inject(TRANSCRIPT_REPOSITORY)
    private readonly transcripts: TranscriptRepositoryPort,
    @Inject(EMBEDDING_REPOSITORY)
    private readonly embeddings: EmbeddingRepositoryPort,
    @Inject(LANGUAGE_MODEL) private readonly model: LanguageModelPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(payload: SermonJobPayload, context: JobContext): Promise<void> {
    await this.pipeline.run(payload, context, async (sermon) => {
      await this.pipeline.enterStage(sermon, 'INDEX');
      const segments = await this.transcripts.listSegments(
        payload.churchId,
        payload.sermonId,
      );
      const title = sermon.title;
      const rows: EmbeddingRow[] = [];
      for (
        let start = 0;
        start < segments.length;
        start += EMBEDDING_BATCH_SIZE
      ) {
        const batch = segments.slice(start, start + EMBEDDING_BATCH_SIZE);
        const { vectors } = await this.model.embed({
          context: {
            operation: 'sermon.embed',
            churchId: payload.churchId,
            sermonId: payload.sermonId,
          },
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
            metadata: {
              sequence: segment.sequence,
              startTimeMs: segment.startTimeMs,
              endTimeMs: segment.endTimeMs,
            },
          });
        });
      }
      await this.uow.run(async () => {
        await this.embeddings.replaceForSermon(
          payload.churchId,
          payload.sermonId,
          rows,
        );
        sermon.markReady(this.clock.now());
        await this.pipeline.persist(sermon);
      });
    });
  }
}
