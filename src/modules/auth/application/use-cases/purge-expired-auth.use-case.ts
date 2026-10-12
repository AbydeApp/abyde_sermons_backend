import { Inject, Injectable } from '@nestjs/common';
import {
  CLOCK,
  type ClockPort,
} from '../../../../shared/application/ports/clock.port.js';
import {
  PASSWORD_RESET_REPOSITORY,
  type PasswordResetRepositoryPort,
  SESSION_REPOSITORY,
  type SessionRepositoryPort,
} from '../ports/out/session-repository.port.js';

/** Kept for a while after expiry so recent sign-in history stays available for support. */
const RETAIN_EXPIRED_MS = 30 * 24 * 3600 * 1000;

/** Maintenance: removes long-expired sessions and reset tokens so these tables do not grow forever. */
@Injectable()
export class PurgeExpiredAuthUseCase {
  constructor(
    @Inject(SESSION_REPOSITORY)
    private readonly sessions: SessionRepositoryPort,
    @Inject(PASSWORD_RESET_REPOSITORY)
    private readonly resets: PasswordResetRepositoryPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(): Promise<{ sessions: number; resetTokens: number }> {
    const cutoff = new Date(this.clock.now().getTime() - RETAIN_EXPIRED_MS);
    return {
      sessions: await this.sessions.deleteExpiredBefore(cutoff),
      resetTokens: await this.resets.deleteExpiredBefore(cutoff),
    };
  }
}
