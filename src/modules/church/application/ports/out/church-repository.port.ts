import type { Church } from '../../../domain/church.entity.js';

export const CHURCH_REPOSITORY = Symbol('CHURCH_REPOSITORY');

export interface ChurchRepositoryPort {
  findById(id: string): Promise<Church | null>;
  findByUserId(userId: string): Promise<Church | null>;
  findIdByUserId(userId: string): Promise<string | null>;
  slugExists(slug: string): Promise<boolean>;
  /** Insert-or-update; throws CHURCH_EXISTS when the user already owns a church. */
  save(church: Church): Promise<void>;
}
