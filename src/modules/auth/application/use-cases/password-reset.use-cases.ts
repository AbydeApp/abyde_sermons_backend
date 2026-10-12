import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE, type CachePort } from '../../../../shared/application/ports/cache.port.js';
import { CLOCK, type ClockPort } from '../../../../shared/application/ports/clock.port.js';
import { QUEUE, QUEUES, type QueuePort } from '../../../../shared/application/ports/queue.port.js';
import { TOKEN_GENERATOR, type TokenGeneratorPort } from '../../../../shared/application/ports/secret-box.port.js';
import { UNIT_OF_WORK, type UnitOfWorkPort } from '../../../../shared/application/ports/unit-of-work.port.js';
import { DomainError } from '../../../../shared/domain/domain-error.js';
import { newId } from '../../../../shared/domain/id.js';
import type { EmailMessage } from '../../../../shared/application/ports/email.port.js';
import { assertPasswordPolicy } from '../../domain/password-policy.js';
import { AUTH_SETTINGS, type AuthSettings } from '../auth-settings.js';
import { USER_REPOSITORY, type UserRepositoryPort } from '../ports/out/user-repository.port.js';
import { PASSWORD_HASHER, type PasswordHasherPort, PASSWORD_RESET_REPOSITORY, type PasswordResetRepositoryPort, SESSION_REPOSITORY,
  type SessionRepositoryPort } from '../ports/out/session-repository.port.js';
import { evictSessions } from '../session-cache.js';

export const PASSWORD_RESET_REQUEST_JOB = {
  queue: QUEUES.EMAIL,
  name: 'password-reset-request',
} as const;

const invalidToken = () =>
  new DomainError(
    'UNPROCESSABLE',
    'INVALID_RESET_TOKEN',
    'This reset link is invalid or has expired.',
    {
      token: ['This reset link is invalid or has expired'],
    },
  );

@Injectable()
export class ForgotPasswordUseCase {
  private readonly logger = new Logger(ForgotPasswordUseCase.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(PASSWORD_RESET_REPOSITORY)
    private readonly resets: PasswordResetRepositoryPort,
    @Inject(TOKEN_GENERATOR) private readonly tokens: TokenGeneratorPort,
    @Inject(QUEUE) private readonly queue: QueuePort,
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(AUTH_SETTINGS) private readonly settings: AuthSettings,
  ) {}

  /**
   * Request path: identical work for every email (one cache write, one enqueue), so neither the
   * response nor its timing reveals whether an account exists.
   */
  async execute(rawEmail: string): Promise<void> {
    const email = rawEmail.trim().toLowerCase();
    // At most one reset email per address per minute; silently dropped beyond that.
    if (!(await this.cache.setIfAbsent(`password-reset:${email}`, 1, 60)))
      return;
    await this.queue
      .enqueue(
        PASSWORD_RESET_REQUEST_JOB.queue,
        PASSWORD_RESET_REQUEST_JOB.name,
        { email },
      )
      .catch((error: unknown) => {
        this.logger.error(
          { err: error },
          'Failed to enqueue password reset request',
        );
      });
  }

  /** Background job: looks the account up and, if it exists, issues a token and sends the email. */
  async process(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (!user) return;
    const now = this.clock.now();
    await this.resets.invalidateAllForUser(user.id, now);
    const { token, hash } = this.tokens.generate();
    await this.resets.create({
      id: newId(),
      userId: user.id,
      tokenHash: hash,
      expiresAt: new Date(
        now.getTime() + this.settings.resetTokenTtlMinutes * 60_000,
      ),
    });
    const link = `${this.settings.webUrl}/reset-password?token=${encodeURIComponent(token)}`;
    const message: EmailMessage = {
      to: user.email,
      subject: 'Reset your Abyde Sermon password',
      text: `Hi ${user.fullName},\n\nUse the link below to choose a new password. It expires in ${this.settings.resetTokenTtlMinutes} minutes.\n\n${link}\n\nIf you didn't ask for this, you can ignore this email.`,
    };
    await this.queue.enqueue(QUEUES.EMAIL, 'send', message);
  }
}

@Injectable()
export class ResetPasswordUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(PASSWORD_RESET_REPOSITORY)
    private readonly resets: PasswordResetRepositoryPort,
    @Inject(SESSION_REPOSITORY)
    private readonly sessions: SessionRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    @Inject(TOKEN_GENERATOR) private readonly tokens: TokenGeneratorPort,
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
  ) {}

  async execute(input: { token: string; password: string }): Promise<void> {
    const now = this.clock.now();
    const record = await this.resets.findByTokenHash(
      this.tokens.hash(input.token),
    );
    if (!record || record.usedAt || record.expiresAt <= now)
      throw invalidToken();
    assertPasswordPolicy(input.password);
    const user = await this.users.findById(record.userId);
    if (!user) throw invalidToken();
    user.changePasswordHash(await this.hasher.hash(input.password));
    const revoked = await this.uow.run(async () => {
      if (!(await this.resets.consume(record.id, now))) throw invalidToken(); // single use under concurrency
      await this.users.save(user);
      return this.sessions.revokeAllForUser(user.id, now);
    });
    await evictSessions(this.cache, revoked);
  }
}
