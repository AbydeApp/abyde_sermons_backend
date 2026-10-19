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
  STORAGE,
  type StoragePort,
} from '../../../../shared/application/ports/storage.port.js';
import { PROCESSING_STATUSES } from '../../domain/processing.js';
import {
  SERMON_REPOSITORY,
  type SermonRepositoryPort,
} from '../ports/out/sermon-repository.port.js';

const BATCH = 200;

/**
 * Maintenance: deletes original sermon uploads whose plan retention has passed. Everything derived
 * from them (transcript, intelligence, content, rendered media, publishing records) stays.
 *
 * Processes current state ("every expired original still stored"), so missed runs need no replay.
 * Safe to repeat: deleting a missing object succeeds, and the row is marked only once.
 */
@Injectable()
export class PurgeExpiredSourcesUseCase {
  private readonly logger = new Logger(PurgeExpiredSourcesUseCase.name);

  constructor(
    @Inject(SERMON_REPOSITORY) private readonly sermons: SermonRepositoryPort,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(guard?: RunGuard): Promise<number> {
    const now = this.clock.now();
    let removed = 0;
    for (const asset of await this.sermons.findExpiredAssets(now, BATCH)) {
      await checkpoint(guard);
      // A sermon still being processed needs its original; it is removed on a later run.
      const sermon = await this.sermons.findById(
        asset.churchId,
        asset.sermonId,
      );
      if (sermon && PROCESSING_STATUSES.includes(sermon.status)) continue;
      await this.storage.deleteObject(asset.objectKey);
      await this.sermons.markAssetDeleted(asset.churchId, asset.id, now);
      removed += 1;
    }
    if (removed > 0)
      this.logger.log({ removed }, 'Removed expired sermon originals');
    return removed;
  }
}
