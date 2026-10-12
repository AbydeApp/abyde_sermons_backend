import { Inject, Injectable } from '@nestjs/common';
import { CHURCH_DIRECTORY,type ChurchDirectoryPort } from '../../../../shared/application/auth-context.js';
import { CACHE, type CachePort } from '../../../../shared/application/ports/cache.port.js';
import { DomainError } from '../../../../shared/domain/domain-error.js';
import { type IssuedSession, type MeView, toMeView } from '../me.js';
import { USER_REPOSITORY, type UserRepositoryPort } from '../ports/out/user-repository.port.js';
import { PASSWORD_HASHER, type PasswordHasherPort } from '../ports/out/session-repository.port.js';
import { SessionIssuer } from './session-issuer.js';

/** Failures allowed from one IP for one email, and for one email across all IPs, per window. */
const MAX_FAILURES = 10;
const MAX_FAILURES_ALL_IPS = 50;
const FAILURE_WINDOW_SECONDS = 15 * 60;
// Verified when the email is unknown so response time does not reveal which emails exist.
const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export const invalidCredentials = () =>
  new DomainError(
    'UNAUTHENTICATED',
    'INVALID_CREDENTIALS',
    'The email or password is incorrect.',
  );

@Injectable()
export class LoginUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    @Inject(SessionIssuer) private readonly sessions: SessionIssuer,
    @Inject(CHURCH_DIRECTORY) private readonly churches: ChurchDirectoryPort,
    @Inject(CACHE) private readonly cache: CachePort,
  ) {}

  async execute(input: {
    email: string;
    password: string;
    remember: boolean;
    userAgent: string | null;
    ip: string | null;
  }): Promise<{ me: MeView; session: IssuedSession }> {
    const email = input.email.trim().toLowerCase();
    // Lockout is per email + IP, so an attacker cannot lock the real owner out from elsewhere.
    // A higher ceiling per email across all IPs still stops distributed guessing.
    const ipKey = `login-failures:${email}:${input.ip ?? 'unknown'}`;
    const emailKey = `login-failures:${email}`;
    if (
      ((await this.cache.get<number>(ipKey)) ?? 0) >= MAX_FAILURES ||
      ((await this.cache.get<number>(emailKey)) ?? 0) >= MAX_FAILURES_ALL_IPS
    ) {
      throw new DomainError(
        'RATE_LIMITED',
        'TOO_MANY_ATTEMPTS',
        'Too many sign-in attempts. Try again in a few minutes.',
      );
    }
    const user = await this.users.findByEmail(email);
    const valid = await this.hasher.verify(
      input.password,
      user?.passwordHash ?? DUMMY_HASH,
    );
    if (!user || !valid) {
      await this.cache.increment(ipKey, FAILURE_WINDOW_SECONDS);
      await this.cache.increment(emailKey, FAILURE_WINDOW_SECONDS);
      throw invalidCredentials();
    }
    await this.cache.del(ipKey);
    const session = await this.sessions.issue(
      user.id,
      input.remember,
      input.userAgent,
    );
    return {
      me: toMeView(user, await this.churches.findViewByUserId(user.id)),
      session,
    };
  }
}
