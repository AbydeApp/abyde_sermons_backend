import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type AuthContext, type ChurchDirectoryPort, type ChurchView } from '../../shared/application/auth-context.js';
import type { ChurchAIProfile, ChurchProfilePort } from '../../shared/application/church-profile.js';
import { defineJobHandler, JOB_HANDLER_REGISTRY, type JobHandlerRegistry } from '../../shared/application/jobs.js';
import { CACHE, type CachePort } from '../../shared/application/ports/cache.port.js';
import { CLOCK, type ClockPort } from '../../shared/application/ports/clock.port.js';
import { QUEUE, QUEUES, type QueuePort } from '../../shared/application/ports/queue.port.js';
import { TOKEN_GENERATOR, type TokenGeneratorPort } from '../../shared/application/ports/secret-box.port.js';
import { UNIT_OF_WORK, type UnitOfWorkPort } from '../../shared/application/ports/unit-of-work.port.js';
import { notFound } from '../../shared/domain/domain-error.js';
import { newId } from '../../shared/domain/id.js';
import { APP_CONFIG } from '../../shared/infrastructure/config/config.module.js';
import type { AppConfig } from '../../shared/infrastructure/config/env.schema.js';
import { ACCESS_TOKEN_SIGNER, type AccessTokenSigner } from './adapters/access-token-signer.js';
import { PASSWORD_HASHER, type PasswordHasher } from './adapters/password-hasher.js';
import { AUTH_REPOSITORY, type AuthRepository, type ChurchRecord, type UserRecord } from './auth.repository.js';
import {
  applyChurchPatch, assertPasswordPolicy, type AuthTokens, DEFAULT_CHURCH_NAME, DEFAULT_OWNER_ROLE, type EditableChurchFields,
  newChurchRecord, SLUG_SUFFIX_LENGTH, toChurchView, CHURCH_ID_CACHE_SECONDS, churchIdCacheKey, DUMMY_HASH, emailChangedNotice,
  emailNotVerified, emailTaken, generateOtp, invalidCredentials, invalidRefreshToken, invalidResetToken,
  LOGIN_FAILURE_WINDOW_SECONDS, loginFailuresKey, MAX_LOGIN_FAILURES, type MeView, normalizeEmail, normalizeName,
  normalizePhone, OTP_MAX_ATTEMPTS, OTP_RESEND_SECONDS, OTP_TTL_MS, otpExpired, otpHashInput, otpLocked, otpSentKey,
  otpUnknown, otpWrong, PASSWORD_RESET_REQUEST_JOB, PASSWORD_RESET_THROTTLE_SECONDS, passwordResetEmail,
  passwordResetKey, passwordResetLink, PURGE_EVERY_MS, PURGE_EXPIRED_AUTH_JOB, RETAIN_EXPIRED_MS, SIGNED_OUT,
  sessionRevokedKey, toMeView, tooManySignInAttempts, trimLower, verificationEmail, wrongPassword,
} from './helper.js';

/** Accounts and sessions, plus the user's church (the tenant) which other modules read through the shared ports. */
@Injectable()
export class AuthService implements OnModuleInit, ChurchDirectoryPort, ChurchProfilePort {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repo: AuthRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(ACCESS_TOKEN_SIGNER) private readonly signer: AccessTokenSigner,
    @Inject(TOKEN_GENERATOR) private readonly tokens: TokenGeneratorPort,
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(QUEUE) private readonly queue: QueuePort,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWorkPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      defineJobHandler<{ email: string }>(PASSWORD_RESET_REQUEST_JOB, (payload) =>
        this.sendPasswordReset(payload.email),
      ),
    );
    this.registry.register(
      defineJobHandler(PURGE_EXPIRED_AUTH_JOB, async () => void (await this.purgeExpired())),
    );
    this.registry.registerRecurring({
      queue: PURGE_EXPIRED_AUTH_JOB.queue,
      jobName: PURGE_EXPIRED_AUTH_JOB.name,
      everyMs: PURGE_EVERY_MS,
    });
  }

  // ───────────── Sign up / sign in / sign out ─────────────

  /** Creates the account and emails a one-time code. No tokens exist until the code is verified. */
  async register(input: { fullName: string; email: string; password: string; churchName?: string }): Promise<{ email: string }> {
    assertPasswordPolicy(input.password);
    const fullName = normalizeName(input.fullName);
    const email = normalizeEmail(input.email);
    const existing = await this.repo.findUserByEmail(email);
    if (existing?.emailVerifiedAt) throw emailTaken();
    const passwordHash = await this.hasher.hash(input.password);
    // An abandoned, never-verified signup is overwritten so the owner can try again.
    const user: UserRecord = existing
      ? { ...existing, fullName, passwordHash }
      : {
          id: newId(),
          fullName,
          email,
          passwordHash,
          emailVerifiedAt: null,
          phoneNumber: null,
          createdAt: this.clock.now(),
        };
    await this.repo.saveUser(user); // unique index resolves concurrent registrations (EMAIL_TAKEN)
    await this.createChurchForUser(user.id, input.churchName);
    await this.sendVerificationCode(user);
    return { email };
  }

  /** Confirms the emailed code and signs the user in. */
  async verifyEmail(input: { email: string; code: string; userAgent: string | null }): Promise<{ me: MeView; tokens: AuthTokens }> {
    const user = await this.repo.findUserByEmail(trimLower(input.email));
    const record = user && (await this.repo.findEmailVerification(user.id));
    if (!user || !record) throw otpUnknown();
    if (record.expiresAt <= this.clock.now()) throw otpExpired();
    // Count the guess before comparing so parallel requests cannot exceed the limit.
    if ((await this.repo.recordFailedVerification(user.id)) > OTP_MAX_ATTEMPTS) throw otpLocked();
    if (!this.codeMatches(user.id, input.code.trim(), record.codeHash)) throw otpWrong();
    await this.repo.deleteEmailVerification(user.id);
    const verified = { ...user, emailVerifiedAt: this.clock.now() };
    await this.repo.saveUser(verified);
    const tokens = await this.startSession(user.id, false, input.userAgent);
    return { me: toMeView(verified, await this.findViewByUserId(user.id)), tokens };
  }

  /** Same answer whether or not the account exists, so this cannot be used to probe emails. */
  async resendVerification(rawEmail: string): Promise<void> {
    const user = await this.repo.findUserByEmail(trimLower(rawEmail));
    if (user && !user.emailVerifiedAt) await this.sendVerificationCode(user);
  }

  async login(input: { email: string; password: string; remember: boolean; userAgent: string | null }): Promise<{ me: MeView; tokens: AuthTokens }> {
    const email = trimLower(input.email);
    const failuresKey = loginFailuresKey(email);
    if (((await this.cache.get<number>(failuresKey)) ?? 0) >= MAX_LOGIN_FAILURES) throw tooManySignInAttempts();
    const user = await this.repo.findUserByEmail(email);
    const valid = await this.hasher.verify(input.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !valid) {
      await this.cache.increment(failuresKey, LOGIN_FAILURE_WINDOW_SECONDS);
      throw invalidCredentials();
    }
    await this.cache.del(failuresKey);
    if (!user.emailVerifiedAt) {
      await this.sendVerificationCode(user);
      throw emailNotVerified();
    }
    const tokens = await this.startSession(user.id, input.remember, input.userAgent);
    return { me: toMeView(user, await this.findViewByUserId(user.id)), tokens };
  }

  /** Exchanges a refresh token for a new pair. The old refresh token stops working immediately. */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const now = this.clock.now();
    const hash = this.tokens.hash(refreshToken);
    const session = await this.repo.findSessionByTokenHash(hash);
    if (!session || session.revokedAt || session.expiresAt <= now) throw invalidRefreshToken();
    const next = this.tokens.generate();
    if (!(await this.repo.rotateSession(session.id, hash, next.hash, now))) throw invalidRefreshToken();
    return this.mintTokens(session.userId, session.id, next.token);
  }

  /** Idempotent: unknown or already-revoked tokens succeed silently. */
  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    const session = await this.repo.findSessionByTokenHash(this.tokens.hash(refreshToken));
    if (!session) return;
    if (!session.revokedAt) await this.repo.revokeSession(session.id, this.clock.now());
    await this.revokeAccess([session.id]);
  }

  /** Resolves an access token into an AuthContext without touching the database. */
  async resolveAccessToken(token: string): Promise<AuthContext | null> {
    const claims = this.signer.verify(token, this.clock.now());
    if (!claims) return null;
    if ((await this.cache.get(sessionRevokedKey(claims.sessionId))) !== null) return null;
    return {
      userId: claims.userId,
      sessionId: claims.sessionId,
      churchId: await this.churchIdFor(claims.userId),
    };
  }

  // ───────────── Account ─────────────

  async getMe(auth: AuthContext | null): Promise<MeView> {
    if (!auth) return SIGNED_OUT;
    const user = await this.repo.findUserById(auth.userId);
    if (!user) return SIGNED_OUT;
    return toMeView(user, await this.findViewByUserId(user.id));
  }

  async updateProfile(auth: AuthContext, input: { fullName?: string; email?: string; phoneNumber?: string }): Promise<MeView> {
    const found = await this.repo.findUserById(auth.userId);
    if (!found) throw notFound('User');
    const user = { ...found };
    if (input.fullName !== undefined) user.fullName = normalizeName(input.fullName);
    if (input.phoneNumber !== undefined) user.phoneNumber = normalizePhone(input.phoneNumber);
    const newEmail = input.email === undefined ? user.email : normalizeEmail(input.email);
    const emailChanged = newEmail !== found.email;
    if (emailChanged) {
      const existing = await this.repo.findUserByEmail(newEmail);
      if (existing && existing.id !== user.id) throw emailTaken();
      user.email = newEmail;
    }
    await this.repo.saveUser(user);
    if (emailChanged) {
      // The sign-in identity changed: outstanding reset links and other devices must not survive
      // it, and the previous address is told so a hijacked session cannot change it silently.
      const now = this.clock.now();
      await this.repo.invalidatePasswordResetsForUser(user.id, now);
      await this.revokeAccess(await this.repo.revokeAllSessionsForUser(user.id, now, auth.sessionId));
      await this.queue
        .enqueue(QUEUES.EMAIL, 'send', emailChangedNotice(found.email, user.fullName))
        .catch(() => undefined);
    }
    return toMeView(user, await this.findViewByUserId(user.id));
  }

  async changePassword(auth: AuthContext, input: { currentPassword: string; newPassword: string }): Promise<void> {
    const user = await this.repo.findUserById(auth.userId);
    if (!user) throw notFound('User');
    if (!(await this.hasher.verify(input.currentPassword, user.passwordHash))) throw wrongPassword();
    assertPasswordPolicy(input.newPassword, 'newPassword');
    await this.repo.saveUser({ ...user, passwordHash: await this.hasher.hash(input.newPassword) });
    // Sign out every other device; keep the session that made the change.
    const now = this.clock.now();
    await this.repo.invalidatePasswordResetsForUser(user.id, now);
    await this.revokeAccess(await this.repo.revokeAllSessionsForUser(user.id, now, auth.sessionId));
  }

  // ───────────── Password reset ─────────────

  /**
   * Request path: identical work for every email (one cache write, one enqueue), so neither the
   * response nor its timing reveals whether an account exists.
   */
  async requestPasswordReset(rawEmail: string): Promise<void> {
    const email = trimLower(rawEmail);
    // At most one reset email per address per minute; silently dropped beyond that.
    if (!(await this.cache.setIfAbsent(passwordResetKey(email), 1, PASSWORD_RESET_THROTTLE_SECONDS))) return;
    await this.queue
      .enqueue(PASSWORD_RESET_REQUEST_JOB.queue, PASSWORD_RESET_REQUEST_JOB.name, { email })
      .catch((error: unknown) => {
        this.logger.error({ err: error }, 'Failed to enqueue password reset request');
      });
  }

  async resetPassword(input: { token: string; password: string }): Promise<void> {
    const now = this.clock.now();
    const record = await this.repo.findPasswordResetByTokenHash(this.tokens.hash(input.token));
    if (!record || record.usedAt || record.expiresAt <= now) throw invalidResetToken();
    assertPasswordPolicy(input.password);
    const user = await this.repo.findUserById(record.userId);
    if (!user) throw invalidResetToken();
    const passwordHash = await this.hasher.hash(input.password);
    const revoked = await this.uow.run(async () => {
      if (!(await this.repo.consumePasswordReset(record.id, now))) throw invalidResetToken(); // single use under concurrency
      await this.repo.saveUser({ ...user, passwordHash });
      return this.repo.revokeAllSessionsForUser(user.id, now);
    });
    await this.revokeAccess(revoked);
  }

  /** Background job: looks the account up and, if it exists, issues a token and sends the email. */
  private async sendPasswordReset(email: string): Promise<void> {
    const user = await this.repo.findUserByEmail(email);
    if (!user) return;
    const now = this.clock.now();
    await this.repo.invalidatePasswordResetsForUser(user.id, now);
    const { token, hash } = this.tokens.generate();
    const ttlMinutes = this.config.AUTH_RESET_TOKEN_TTL_MINUTES;
    await this.repo.createPasswordReset({
      id: newId(),
      userId: user.id,
      tokenHash: hash,
      expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
    });
    const link = passwordResetLink(this.config.APP_WEB_URL, token);
    await this.queue.enqueue(QUEUES.EMAIL, 'send', passwordResetEmail(user, link, ttlMinutes));
  }

  // ───────────── Church ─────────────

  /** Creates the user's church at signup. Idempotent: an existing church is returned untouched. */
  async createChurchForUser(userId: string, name?: string): Promise<ChurchView> {
    // Serialise per user so a double-submit cannot create two churches (the unique index is the backstop).
    const church = await this.uow.runLocked(`church:create:${userId}`, async () => {
      const existing = await this.repo.findChurchByUserId(userId);
      if (existing) return existing;
      const input = {
        id: newId(),
        userId,
        name: name?.trim() || DEFAULT_CHURCH_NAME,
        ownerRole: DEFAULT_OWNER_ROLE,
      };
      let candidate = newChurchRecord(input);
      if (await this.repo.churchSlugExists(candidate.slug)) {
        candidate = newChurchRecord({ ...input, slugSuffix: newId().slice(0, SLUG_SUFFIX_LENGTH) });
      }
      await this.repo.saveChurch(candidate);
      return candidate;
    });
    return toChurchView(church);
  }

  async getChurch(churchId: string): Promise<ChurchView> {
    const church = await this.repo.findChurchById(churchId);
    if (!church) throw notFound('Church');
    return toChurchView(church);
  }

  async updateChurch(churchId: string, patch: EditableChurchFields): Promise<ChurchView> {
    const current = await this.repo.findChurchById(churchId);
    if (!current) throw notFound('Church');
    const church: ChurchRecord = applyChurchPatch(current, patch);
    await this.repo.saveChurch(church);
    return toChurchView(church);
  }

  // ChurchDirectoryPort
  async findViewByUserId(userId: string): Promise<ChurchView | null> {
    const church = await this.repo.findChurchByUserId(userId);
    return church ? toChurchView(church) : null;
  }

  findIdByUserId(userId: string): Promise<string | null> {
    return this.repo.findChurchIdByUserId(userId);
  }

  async findViewById(churchId: string): Promise<ChurchView | null> {
    const church = await this.repo.findChurchById(churchId);
    return church ? toChurchView(church) : null;
  }

  // ChurchProfilePort: preferences that shape AI prompts
  async findAIProfile(churchId: string): Promise<ChurchAIProfile | null> {
    const church = await this.repo.findChurchById(churchId);
    if (!church) return null;
    return {
      churchId: church.id,
      name: church.name,
      preferredBibleTranslation: church.preferredBibleTranslation,
      devotionalTone: church.devotionalTone,
      socialTone: church.socialTone,
      audienceDescription: church.audienceDescription,
      wordsToAvoid: church.wordsToAvoid,
      additionalAIContext: church.additionalAIContext,
    };
  }

  // ───────────── Maintenance ─────────────

  /** Removes long-expired sessions, reset tokens and codes so these tables do not grow forever. */
  async purgeExpired(): Promise<{ sessions: number; resetTokens: number }> {
    const cutoff = new Date(this.clock.now().getTime() - RETAIN_EXPIRED_MS);
    await this.repo.deleteExpiredEmailVerifications(cutoff);
    return {
      sessions: await this.repo.deleteExpiredSessions(cutoff),
      resetTokens: await this.repo.deleteExpiredPasswordResets(cutoff),
    };
  }

  // ───────────── Internals ─────────────

  /** Creates the session; its refresh token lives for the session lifetime. */
  private async startSession(userId: string, remember: boolean, userAgent: string | null): Promise<AuthTokens> {
    const now = this.clock.now();
    const ttlMs = remember
      ? this.config.AUTH_REMEMBER_TTL_DAYS * 24 * 3600 * 1000
      : this.config.AUTH_SESSION_TTL_HOURS * 3600 * 1000;
    const { token, hash } = this.tokens.generate();
    const sessionId = newId();
    await this.repo.createSession({
      id: sessionId,
      userId,
      tokenHash: hash,
      expiresAt: new Date(now.getTime() + ttlMs),
      userAgent: userAgent?.slice(0, 255) ?? null,
      now,
    });
    return this.mintTokens(userId, sessionId, token);
  }

  private mintTokens(userId: string, sessionId: string, refreshToken: string): AuthTokens {
    const now = this.clock.now();
    const expiresIn = this.config.AUTH_ACCESS_TOKEN_TTL_MINUTES * 60;
    return {
      accessToken: this.signer.sign({ userId, sessionId }, now, new Date(now.getTime() + expiresIn * 1000)),
      refreshToken,
      expiresIn,
    };
  }

  private codeMatches(userId: string, code: string, expectedHash: string): boolean {
    const actual = Buffer.from(this.tokens.hash(otpHashInput(userId, code)));
    const expected = Buffer.from(expectedHash);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  /** Issues and emails a fresh code; at most one per minute per account, extra requests are dropped. */
  private async sendVerificationCode(user: UserRecord): Promise<void> {
    if (!(await this.cache.setIfAbsent(otpSentKey(user.id), 1, OTP_RESEND_SECONDS))) return;
    const code = generateOtp();
    await this.repo.saveEmailVerification({
      userId: user.id,
      codeHash: this.tokens.hash(otpHashInput(user.id, code)),
      expiresAt: new Date(this.clock.now().getTime() + OTP_TTL_MS),
    });
    await this.queue.enqueue(QUEUES.EMAIL, 'send', verificationEmail(user, code)).catch((error: unknown) => {
      this.logger.error({ err: error }, 'Failed to enqueue verification email');
    });
  }

  /**
   * Marks sessions revoked so their still-valid access tokens stop working immediately. The
   * tombstone only has to outlive an access token.
   */
  private async revokeAccess(sessionIds: string[]): Promise<void> {
    const ttl = this.config.AUTH_ACCESS_TOKEN_TTL_MINUTES * 60 + 60;
    for (const id of sessionIds) await this.cache.set(sessionRevokedKey(id), 1, ttl);
  }

  private async churchIdFor(userId: string): Promise<string | null> {
    const cached = await this.cache.get<string>(churchIdCacheKey(userId));
    if (cached) return cached;
    const churchId = await this.findIdByUserId(userId);
    // A church never changes owner, so positive results are safe to cache; misses are not cached.
    if (churchId) await this.cache.set(churchIdCacheKey(userId), churchId, CHURCH_ID_CACHE_SECONDS);
    return churchId;
  }
}
