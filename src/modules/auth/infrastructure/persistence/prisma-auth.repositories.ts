import { Inject, Injectable } from '@nestjs/common';
import {
  isUniqueViolation,
  PrismaService,
} from '../../../../shared/infrastructure/prisma/prisma.service.js';
import type { User as UserRow } from '../../../../generated/prisma/client.js';
import { User } from '../../domain/user.entity.js';
import type { UserRepositoryPort } from '../../application/ports/out/user-repository.port.js';
import type {
  PasswordResetRecord,
  PasswordResetRepositoryPort,
  SessionRecord,
  SessionRepositoryPort,
} from '../../application/ports/out/session-repository.port.js';
import { emailTaken } from '../../application/use-cases/register.use-case.js';

const toUser = (row: UserRow): User =>
  User.restore({
    id: row.id,
    fullName: row.fullName,
    email: row.email,
    passwordHash: row.passwordHash,
    emailVerifiedAt: row.emailVerifiedAt,
    onboardingCompleted: row.onboardingCompleted,
    createdAt: row.createdAt,
  });

@Injectable()
export class PrismaUserRepository implements UserRepositoryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<User | null> {
    const row = await this.prisma.db.user.findUnique({ where: { id } });
    return row ? toUser(row) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const row = await this.prisma.db.user.findUnique({ where: { email } });
    return row ? toUser(row) : null;
  }

  async save(user: User): Promise<void> {
    const { id, createdAt, ...data } = user.snapshot();
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
}

@Injectable()
export class PrismaSessionRepository implements SessionRepositoryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(session: {
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

  findByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
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

  async touch(id: string, at: Date): Promise<void> {
    await this.prisma.db.session.updateMany({
      where: { id, revokedAt: null },
      data: { lastSeenAt: at },
    });
  }

  async revoke(id: string, at: Date): Promise<void> {
    await this.prisma.db.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: at },
    });
  }

  async revokeAllForUser(
    userId: string,
    at: Date,
    exceptSessionId?: string,
  ): Promise<string[]> {
    const where = {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    };
    const revoked = await this.prisma.db.session.updateManyAndReturn({
      where,
      data: { revokedAt: at },
      select: { tokenHash: true },
    });
    return revoked.map((session) => session.tokenHash);
  }

  async deleteExpiredBefore(cutoff: Date): Promise<number> {
    return (
      await this.prisma.db.session.deleteMany({
        where: { expiresAt: { lt: cutoff } },
      })
    ).count;
  }
}

@Injectable()
export class PrismaPasswordResetRepository implements PasswordResetRepositoryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(record: Omit<PasswordResetRecord, 'usedAt'>): Promise<void> {
    await this.prisma.db.passwordResetToken.create({ data: record });
  }

  findByTokenHash(tokenHash: string): Promise<PasswordResetRecord | null> {
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

  async consume(id: string, at: Date): Promise<boolean> {
    const result = await this.prisma.db.passwordResetToken.updateMany({
      where: { id, usedAt: null },
      data: { usedAt: at },
    });
    return result.count === 1;
  }

  async invalidateAllForUser(userId: string, at: Date): Promise<void> {
    await this.prisma.db.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: at },
    });
  }

  async deleteExpiredBefore(cutoff: Date): Promise<number> {
    return (
      await this.prisma.db.passwordResetToken.deleteMany({
        where: { expiresAt: { lt: cutoff } },
      })
    ).count;
  }
}
