export const SESSION_REPOSITORY = Symbol('SESSION_REPOSITORY');

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  lastSeenAt: Date;
}

export interface SessionRepositoryPort {
  create(
    session: Omit<SessionRecord, 'revokedAt' | 'lastSeenAt'> & {
      userAgent: string | null;
      now: Date;
    },
  ): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  touch(id: string, at: Date): Promise<void>;
  revoke(id: string, at: Date): Promise<void>;
  /** Revokes every active session for the user (optionally keeping one); returns revoked token hashes. */
  revokeAllForUser(
    userId: string,
    at: Date,
    exceptSessionId?: string,
  ): Promise<string[]>;
  /** Maintenance: deletes sessions that expired before `cutoff`; returns how many. */
  deleteExpiredBefore(cutoff: Date): Promise<number>;
}

export const PASSWORD_RESET_REPOSITORY = Symbol('PASSWORD_RESET_REPOSITORY');

export interface PasswordResetRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
}

export interface PasswordResetRepositoryPort {
  create(record: Omit<PasswordResetRecord, 'usedAt'>): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<PasswordResetRecord | null>;
  /** Marks the token used only if still unused; returns false when another request won the race. */
  consume(id: string, at: Date): Promise<boolean>;
  invalidateAllForUser(userId: string, at: Date): Promise<void>;
  deleteExpiredBefore(cutoff: Date): Promise<number>;
}

export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');

export interface PasswordHasherPort {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}
