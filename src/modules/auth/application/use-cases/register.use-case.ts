import { Inject, Injectable } from '@nestjs/common';
import { CACHE, type CachePort,} from '../../../../shared/application/ports/cache.port.js';
import { DomainError } from '../../../../shared/domain/domain-error.js';
import { newId } from '../../../../shared/domain/id.js';
import { CLOCK, type ClockPort } from '../../../../shared/application/ports/clock.port.js';
import { User } from '../../domain/user.entity.js';
import { assertPasswordPolicy } from '../../domain/password-policy.js';
import { normalizeEmail } from '../../domain/email.js';
import { type IssuedSession, type MeView, toMeView } from '../me.js';
import { USER_REPOSITORY, type UserRepositoryPort } from '../ports/out/user-repository.port.js';
import { PASSWORD_HASHER, type PasswordHasherPort } from '../ports/out/session-repository.port.js';
import { SessionIssuer } from './session-issuer.js';

export interface RegisterInput {
  fullName: string;
  email: string;
  password: string;
  userAgent: string | null;
  ip: string | null;
}

const MAX_EMAIL_TAKEN_PER_HOUR = 5;

export const emailTaken = () =>
  new DomainError(
    'CONFLICT',
    'EMAIL_TAKEN',
    'An account with this email already exists.',
    {
      email: ['An account with this email already exists'],
    },
  );

@Injectable()
export class RegisterUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    @Inject(SessionIssuer) private readonly sessions: SessionIssuer,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(CACHE) private readonly cache: CachePort,
  ) {}

  async execute( input: RegisterInput ): Promise<{ me: MeView; session: IssuedSession }> {
    assertPasswordPolicy(input.password);
    const email = normalizeEmail(input.email);
    // The web contract requires an explicit EMAIL_TAKEN, which reveals that an account exists.
    // Each client may only collect a handful of those answers per hour, so it cannot be used
    // to test a list of addresses.
    const probeKey = `email-taken:${input.ip ?? 'unknown'}`;
    if (
      ((await this.cache.get<number>(probeKey)) ?? 0) >=
      MAX_EMAIL_TAKEN_PER_HOUR
    ) {
      throw new DomainError(
        'RATE_LIMITED',
        'TOO_MANY_ATTEMPTS',
        'Too many attempts. Try again later.',
      );
    }
    if (await this.users.findByEmail(email)) {
      await this.cache.increment(probeKey, 3600);
      throw emailTaken();
    }
    const user = User.register({
      id: newId(),
      fullName: input.fullName,
      email,
      passwordHash: await this.hasher.hash(input.password),
      now: this.clock.now(),
    });
    await this.users.save(user); // unique index resolves concurrent registrations (EMAIL_TAKEN)
    const session = await this.sessions.issue(user.id, false, input.userAgent);
    return { me: toMeView(user, null), session };
  }
}
