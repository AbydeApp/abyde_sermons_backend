import { createHash, randomUUID } from 'node:crypto';

/** Opaque, non-sequential identifier for every persisted record. */
export const newId = (): string => randomUUID();

/**
 * A UUID-shaped id that is always the same for the same seed (version nibble 8, RFC 9562 custom).
 * Lets a retried job address the rows and objects an earlier attempt may already have written.
 */
export function deterministicId(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  const variant = ((parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
