import { createHash } from 'node:crypto';

/** RFC 7636 S256 code challenge for a verifier. */
export const pkceChallenge = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');
