import { Inject, Injectable } from '@nestjs/common';
import type { Church as ChurchRow, User as UserRow } from '../../generated/prisma/client.js';
import {
  isUniqueViolation,
  PrismaService,
} from '../../shared/infrastructure/prisma/prisma.service.js';
import { churchExists, emailTaken } from './helper.js';

export const AUTH_REPOSITORY = Symbol('AUTH_REPOSITORY');

export interface ChurchRecord {
  id: string;
  userId: string;
  name: string;
  slug: string;
  ownerRole: string;
  denomination: string | null;
  website: string | null;
  description: string | null;
  preferredBibleTranslation: string;
  primaryColor: string | null;
  secondaryColor: string | null;
  devotionalTone: string | null;
  socialTone: string | null;
  audienceDescription: string;
  wordsToAvoid: string;
  additionalAIContext: string;
}

export interface UserRecord {
  id: string;
  fullName: string;
  email: string;
  passwordHash: string;
  emailVerifiedAt: Date | null;
  phoneNumber: string | null;
  createdAt: Date;
}

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  lastSeenAt: Date;
}

export interface PasswordResetRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
}

export interface EmailVerificationRecord {
  userId: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
}

export interface AuthRepository {
  findUserById(id: string): Promise<UserRecord | null>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  /** Insert-or-update. Throws EMAIL_TAKEN when the email belongs to another user. */
  saveUser(user: UserRecord): Promise<void>;

  findChurchById(id: string): Promise<ChurchRecord | null>;
  findChurchByUserId(userId: string): Promise<ChurchRecord | null>;
  findChurchIdByUserId(userId: string): Promise<string | null>;
  churchSlugExists(slug: string): Promise<boolean>;
  /** Insert-or-update; throws CHURCH_EXISTS when the user already owns a church. */
  saveChurch(church: ChurchRecord): Promise<void>;

  /** Replaces the user's live verification code (and resets its attempt counter). */
  saveEmailVerification(
    record: Omit<EmailVerificationRecord, 'attempts'>,
  ): Promise<void>;
  findEmailVerification(userId: string): Promise<EmailVerificationRecord | null>;
  /** Counts a wrong guess; returns the new total. */
  recordFailedVerification(userId: string): Promise<number>;
  deleteEmailVerification(userId: string): Promise<void>;
  deleteExpiredEmailVerifications(cutoff: Date): Promise<number>;

  createSession(
    session: Omit<SessionRecord, 'revokedAt' | 'lastSeenAt'> & {
      userAgent: string | null;
      now: Date;
    },
  ): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  /** Swaps the refresh token hash only if it still matches (a replayed token loses); false means it did not. */
  rotateSession(
    id: string,
    currentTokenHash: string,
    nextTokenHash: string,
    at: Date,
  ): Promise<boolean>;
  revokeSession(id: string, at: Date): Promise<void>;
  /** Revokes every active session for the user (optionally keeping one); returns the revoked session ids. */
  revokeAllSessionsForUser(
    userId: string,
    at: Date,
    exceptSessionId?: string,
  ): Promise<string[]>;
  deleteExpiredSessions(cutoff: Date): Promise<number>;

  createPasswordReset(record: Omit<PasswordResetRecord, 'usedAt'>): Promise<void>;
  findPasswordResetByTokenHash(
    tokenHash: string,
  ): Promise<PasswordResetRecord | null>;
  /** Marks the token used only if still unused; false means another request won the race. */
  consumePasswordReset(id: string, at: Date): Promise<boolean>;
  invalidatePasswordResetsForUser(userId: string, at: Date): Promise<void>;
  deleteExpiredPasswordResets(cutoff: Date): Promise<number>;
}

const toUser = (row: UserRow): UserRecord => ({
  id: row.id,
  fullName: row.fullName,
  email: row.email,
  passwordHash: row.passwordHash,
  emailVerifiedAt: row.emailVerifiedAt,
  phoneNumber: row.phoneNumber,
  createdAt: row.createdAt,
});

const toChurch = ({ createdAt: _c, updatedAt: _u, ...row }: ChurchRow): ChurchRecord => row;

@Injectable()
export class PrismaAuthRepository implements AuthRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findUserById(id: string): Promise<UserRecord | null> {
    const row = await this.prisma.db.user.findUnique({ where: { id } });
    return row ? toUser(row) : null;
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const row = await this.prisma.db.user.findUnique({ where: { email } });
    return row ? toUser(row) : null;
  }

  async saveUser(user: UserRecord): Promise<void> {
    const { id, createdAt, ...data } = user;
    try {
      await this.prisma.db.user.upsert({
        where: { id },
        create: { id, createdAt, ...data },
        update: data,
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw emailTaken();
      throw error;
    }
  }

  async findChurchById(id: string): Promise<ChurchRecord | null> {
    const row = await this.prisma.db.church.findUnique({ where: { id } });
    return row ? toChurch(row) : null;
  }

  async findChurchByUserId(userId: string): Promise<ChurchRecord | null> {
    const row = await this.prisma.db.church.findUnique({ where: { userId } });
    return row ? toChurch(row) : null;
  }

  async findChurchIdByUserId(userId: string): Promise<string | null> {
    const row = await this.prisma.db.church.findUnique({
      where: { userId },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  async churchSlugExists(slug: string): Promise<boolean> {
    return (await this.prisma.db.church.count({ where: { slug } })) > 0;
  }

  async saveChurch(church: ChurchRecord): Promise<void> {
    const { id, userId, ...data } = church;
    try {
      await this.prisma.db.church.upsert({
        where: { id },
        create: { id, userId, ...data },
        update: data,
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw churchExists();
      throw error;
    }
  }

  async saveEmailVerification(
    record: Omit<EmailVerificationRecord, 'attempts'>,
  ): Promise<void> {
    await this.prisma.db.emailVerification.upsert({
      where: { userId: record.userId },
      create: record,
      update: { ...record, attempts: 0, createdAt: new Date() },
    });
  }

  findEmailVerification(
    userId: string,
  ): Promise<EmailVerificationRecord | null> {
    return this.prisma.db.emailVerification.findUnique({
      where: { userId },
      select: { userId: true, codeHash: true, expiresAt: true, attempts: true },
    });
  }

  async recordFailedVerification(userId: string): Promise<number> {
    const row = await this.prisma.db.emailVerification.update({
      where: { userId },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });
    return row.attempts;
  }

  async deleteEmailVerification(userId: string): Promise<void> {
    await this.prisma.db.emailVerification.deleteMany({ where: { userId } });
  }

  async deleteExpiredEmailVerifications(cutoff: Date): Promise<number> {
    return (
      await this.prisma.db.emailVerification.deleteMany({
        where: { expiresAt: { lt: cutoff } },
      })
    ).count;
  }

  async createSession(session: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    userAgent: string | null;
    now: Date;
  }): Promise<void> {
    await this.prisma.db.session.create({
      data: {
        id: session.id,
        userId: session.userId,
        tokenHash: session.tokenHash,
        expiresAt: session.expiresAt,
        userAgent: session.userAgent,
        createdAt: session.now,
        lastSeenAt: session.now,
      },
    });
  }

  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    return this.prisma.db.session.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        tokenHash: true,
        expiresAt: true,
        revokedAt: true,
        lastSeenAt: true,
      },
    });
  }

  async rotateSession(
    id: string,
    currentTokenHash: string,
    nextTokenHash: string,
    at: Date,
  ): Promise<boolean> {
    const result = await this.prisma.db.session.updateMany({
      where: { id, tokenHash: currentTokenHash, revokedAt: null },
      data: { tokenHash: nextTokenHash, lastSeenAt: at },
    });
    return result.count === 1;
  }

  async revokeSession(id: string, at: Date): Promise<void> {
    await this.prisma.db.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: at },
    });
  }

  async revokeAllSessionsForUser(
    userId: string,
    at: Date,
    exceptSessionId?: string,
  ): Promise<string[]> {
    const revoked = await this.prisma.db.session.updateManyAndReturn({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      data: { revokedAt: at },
      select: { id: true },
    });
    return revoked.map((session) => session.id);
  }

  async deleteExpiredSessions(cutoff: Date): Promise<number> {
    return (
      await this.prisma.db.session.deleteMany({
        where: { expiresAt: { lt: cutoff } },
      })
    ).count;
  }

  async createPasswordReset(
    record: Omit<PasswordResetRecord, 'usedAt'>,
  ): Promise<void> {
    await this.prisma.db.passwordResetToken.create({ data: record });
  }

  findPasswordResetByTokenHash(
    tokenHash: string,
  ): Promise<PasswordResetRecord | null> {
    return this.prisma.db.passwordResetToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        tokenHash: true,
        expiresAt: true,
        usedAt: true,
      },
    });
  }

  async consumePasswordReset(id: string, at: Date): Promise<boolean> {
    const result = await this.prisma.db.passwordResetToken.updateMany({
      where: { id, usedAt: null },
      data: { usedAt: at },
    });
    return result.count === 1;
  }

  async invalidatePasswordResetsForUser(
    userId: string,
    at: Date,
  ): Promise<void> {
    await this.prisma.db.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: at },
    });
  }

  async deleteExpiredPasswordResets(cutoff: Date): Promise<number> {
    return (
      await this.prisma.db.passwordResetToken.deleteMany({
        where: { expiresAt: { lt: cutoff } },
      })
    ).count;
  }
}
