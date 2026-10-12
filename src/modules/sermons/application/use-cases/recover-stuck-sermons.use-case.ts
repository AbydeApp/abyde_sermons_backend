import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  checkpoint,
  type RunGuard,
} from '../../../../shared/application/jobs.js';
import {
  CLOCK,
  type ClockPort,
} from '../../../../shared/application/ports/clock.port.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '../../../../shared/application/ports/unit-of-work.port.js';
import {
  SERMON_REPOSITORY,
  type SermonRepositoryPort,
} from '../ports/out/sermon-repository.port.js';

/** Longer than any healthy run: every phase retries within minutes, so two idle hours means the job was lost. */
export const STUCK_SERMON_AFTER_MS = 2 * 3600 * 1000;
export const INTERRUPTED_MESSAGE =
  'Processing was interrupted. Please try again.';
const BATCH = 100;

/**
 * Maintenance: a sermon can be left "processing" with no job behind it when a worker is killed
 * mid-job or the queue was unavailable when the job was enqueued. Those sermons are marked FAILED
 * at the stage they reached, with retry enabled, so the user is never left with an endless spinner.
 */
@Injectable()
export class RecoverStuckSermonsUseCase {
  private readonly logger = new Logger(RecoverStuckSermonsUseCase.name);

  constructor(
    @Inject(SERMON_REPOSITORY) private readonly sermons: SermonRepositoryPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(guard?: RunGuard): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - STUCK_SERMON_AFTER_MS);
    const stuck = await this.sermons.findStuckProcessing(cutoff, BATCH);
    let recovered = 0;
    for (const candidate of stuck) {
      await checkpoint(guard);
      const attempt = candidate.processingAttempts;
      await this.uow.runLocked(`sermon:${candidate.id}`, async () => {
        // Re-read under the lock: a late job or a user retry may have moved it on.
        const sermon = await this.sermons.findById(
          candidate.churchId,
          candidate.id,
        );
        if (!sermon || !sermon.acceptsJobFor(attempt)) return;
        sermon.markFailed(
          sermon.processingStage ?? 'UPLOAD',
          INTERRUPTED_MESSAGE,
          true,
        );
        if (await this.sermons.updateProcessing(sermon)) recovered++;
      });
    }
    if (recovered > 0)
      this.logger.warn(
        { recovered },
        'Marked stuck sermons as failed (retryable)',
      );
    return recovered;
  }
}
