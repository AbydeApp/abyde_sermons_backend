import { Inject, Injectable } from '@nestjs/common';
import type { EmailMessage } from '../../../../shared/application/ports/email.port.js';
import { QUEUE, QUEUES, type QueuePort } from '../../../../shared/application/ports/queue.port.js';
import { type AuthContext, CHURCH_DIRECTORY, type ChurchDirectoryPort} from '../../../../shared/application/auth-context.js';
import { CACHE, type CachePort } from '../../../../shared/application/ports/cache.port.js';
import { CLOCK, type ClockPort } from '../../../../shared/application/ports/clock.port.js';
import { TOKEN_GENERATOR, type TokenGeneratorPort } from '../../../../shared/application/ports/secret-box.port.js';
import { DomainError, notFound } from '../../../../shared/domain/domain-error.js';
import { assertPasswordPolicy } from '../../domain/password-policy.js';
import { type MeView, SIGNED_OUT, toMeView } from '../me.js';
import { USER_REPOSITORY,type UserRepositoryPort } from '../ports/out/user-repository.port.js';
import {
  PASSWORD_HASHER,
  type PasswordHasherPort,
  PASSWORD_RESET_REPOSITORY,
  type PasswordResetRepositoryPort,
  SESSION_REPOSITORY,
  type SessionRepositoryPort,
} from '../ports/out/session-repository.port.js';
import { evictSessions } from '../session-cache.js';
import { emailTaken } from './register.use-case.js';

const wrongPassword = () =>
  new DomainError(
    'UNPROCESSABLE',
    'WRONG_PASSWORD',
    'Your current password is incorrect.',
    {
      currentPassword: ['Your current password is incorrect'],
    },
  );

@Injectable()
export class GetMeUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(CHURCH_DIRECTORY) private readonly churches: ChurchDirectoryPort,
  ) {}

  async execute(auth: AuthContext | null): Promise<MeView> {
    if (!auth) return SIGNED_OUT;
    const user = await this.users.findById(auth.userId);
    if (!user) return SIGNED_OUT;
    return toMeView(user, await this.churches.findViewByUserId(user.id));
  }
}

@Injectable()
export class LogoutUseCase {
  constructor(
    @Inject(SESSION_REPOSITORY)
    private readonly sessions: SessionRepositoryPort,
    @Inject(TOKEN_GENERATOR) private readonly tokens: TokenGeneratorPort,
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  /** Idempotent: unknown or already-revoked tokens succeed silently. */
  async execute(token: string | undefined): Promise<void> {
    if (!token) return;
    const hash = this.tokens.hash(token);
    const session = await this.sessions.findByTokenHash(hash);
    if (session && !session.revokedAt)
      await this.sessions.revoke(session.id, this.clock.now());
    await evictSessions(this.cache, [hash]);
  }
}

@Injectable()
export class UpdateProfileUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(CHURCH_DIRECTORY) private readonly churches: ChurchDirectoryPort,
    @Inject(SESSION_REPOSITORY)
    private readonly sessions: SessionRepositoryPort,
    @Inject(PASSWORD_RESET_REPOSITORY)
    private readonly resets: PasswordResetRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    @Inject(QUEUE) private readonly queue: QueuePort,
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(
    auth: AuthContext,
    input: { fullName?: string; email?: string; currentPassword?: string },
  ): Promise<MeView> {
    const user = await this.users.findById(auth.userId);
    if (!user) throw notFound('User');
    const previousEmail = user.email;
    if (input.fullName !== undefined) user.rename(input.fullName);
    const emailChanged =
      input.email !== undefined && user.changeEmail(input.email);
    if (emailChanged) {
      // Changing the sign-in identity needs the password, so a borrowed session cannot take over the account.
      if (
        !input.currentPassword ||
        !(await this.hasher.verify(input.currentPassword, user.passwordHash))
      ) {
        throw wrongPassword();
      }
      const existing = await this.users.findByEmail(user.email);
      if (existing && existing.id !== user.id) throw emailTaken();
    }
    await this.users.save(user);
    if (emailChanged) {
      // The sign-in identity changed: outstanding reset links and other devices must not survive
      // it, and the previous address is told so a hijacked session cannot change it silently.
      const now = this.clock.now();
      await this.resets.invalidateAllForUser(user.id, now);
      await evictSessions(
        this.cache,
        await this.sessions.revokeAllForUser(user.id, now, auth.sessionId),
      );
      const notice: EmailMessage = {
        to: previousEmail,
        subject: 'Your Abyde Sermon email address was changed',
        text: `Hi ${user.fullName},\n\nThe email address on your Abyde Sermon account was just changed to a new address. If this was you, no action is needed.\n\nIf it wasn't you, reset your password straight away and contact support.`,
      };
      await this.queue
        .enqueue(QUEUES.EMAIL, 'send', notice)
        .catch(() => undefined);
    }
    return toMeView(user, await this.churches.findViewByUserId(user.id));
  }
}

@Injectable()
export class ChangePasswordUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(SESSION_REPOSITORY)
    private readonly sessions: SessionRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    @Inject(PASSWORD_RESET_REPOSITORY)
    private readonly resets: PasswordResetRepositoryPort,
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async execute(
    auth: AuthContext,
    input: { currentPassword: string; newPassword: string },
  ): Promise<void> {
    const user = await this.users.findById(auth.userId);
    if (!user) throw notFound('User');
    if (!(await this.hasher.verify(input.currentPassword, user.passwordHash))) {
      throw wrongPassword();
    }
    assertPasswordPolicy(input.newPassword, 'newPassword');
    user.changePasswordHash(await this.hasher.hash(input.newPassword));
    await this.users.save(user);
    // Sign out every other device; keep the session that made the change.
    await this.resets.invalidateAllForUser(user.id, this.clock.now());
    const revoked = await this.sessions.revokeAllForUser(
      user.id,
      this.clock.now(),
      auth.sessionId,
    );
    await evictSessions(this.cache, revoked);
  }
}
