import { createHash, randomBytes } from 'node:crypto';
import type { TokenGeneratorPort } from '../../application/ports/secret-box.port.js';

export class RandomTokenGenerator implements TokenGeneratorPort {
  generate(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: this.hash(token) };
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
