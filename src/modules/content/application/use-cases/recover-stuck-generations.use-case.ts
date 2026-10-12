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
  GENERATION_REPOSITORY,
  type GenerationRepositoryPort,
} from '../ports/out/content-repository.port.js';

/** Generation retries finish within a few minutes; half an hour without progress means the job was lost. */
export const STUCK_GENERATION_AFTER_MS = 30 * 60 * 1000;

/**
 * Maintenance: fails generation jobs left QUEUED/PROCESSING/RETRYING with no queue job behind them
 * (worker killed, or queue unavailable at enqueue time), so the group reaches `done` and the web app
 * can offer "Retry failed".
 */
@Injectable()
export class RecoverStuckGenerationsUseCase {
  private readonly logger = new Logger(RecoverStuckGenerationsUseCase.name);

  constructor(
    @Inject(GENERATION_REPOSITORY)
    private readonly generations: GenerationRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(guard?: RunGuard): Promise<number> {
    await checkpoint(guard);
    const cutoff = new Date(
      this.clock.now().getTime() - STUCK_GENERATION_AFTER_MS,
    );
    const failed = await this.generations.failStale(
      cutoff,
      'Generation was interrupted. Please retry.',
    );
    if (failed > 0)
      this.logger.warn({ failed }, 'Marked stuck generation jobs as failed');
    return failed;
  }
}
