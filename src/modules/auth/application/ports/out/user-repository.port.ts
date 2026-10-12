import type { User } from '../../../domain/user.entity.js';

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

export interface UserRepositoryPort {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  /** Insert-or-update. Throws a CONFLICT DomainError (EMAIL_TAKEN) when the email is already used. */
  save(user: User): Promise<void>;
}
