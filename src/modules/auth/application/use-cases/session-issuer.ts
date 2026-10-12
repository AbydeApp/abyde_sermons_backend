import { Inject, Injectable } from '@nestjs/common';
import { newId } from '../../../../shared/domain/id.js';
import { CLOCK, type ClockPort } from '../../../../shared/application/ports/clock.port.js';
import { TOKEN_GENERATOR, type TokenGeneratorPort } from '../../../../shared/application/ports/secret-box.port.js';
import { AUTH_SETTINGS, type AuthSettings } from '../auth-settings.js';
import type { IssuedSession } from '../me.js';
import { SESSION_REPOSITORY, type SessionRepositoryPort } from '../ports/out/session-repository.port.js';

@Injectable()
export class SessionIssuer {
  constructor(
    @Inject(SESSION_REPOSITORY)
    private readonly sessions: SessionRepositoryPort,
    @Inject(TOKEN_GENERATOR) private readonly tokens: TokenGeneratorPort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(AUTH_SETTINGS) private readonly settings: AuthSettings,
  ) {}

  async issue(
    userId: string,
    remember: boolean,
    userAgent: string | null,
  ): Promise<IssuedSession> {
    const now = this.clock.now();
    const ttlMs = remember
      ? this.settings.rememberTtlDays * 24 * 3600 * 1000
      : this.settings.sessionTtlHours * 3600 * 1000;
    const expiresAt = new Date(now.getTime() + ttlMs);
    const { token, hash } = this.tokens.generate();
    await this.sessions.create({
      id: newId(),
      userId,
      tokenHash: hash,
      expiresAt,
      userAgent: userAgent?.slice(0, 255) ?? null,
      now,
    });
    return { token, expiresAt };
  }
}
