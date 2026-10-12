import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import type { TokenCipherPort } from '../../../modules/social/application/ports/out/social-support.ports.js';

const VERSION = 't1';

const keyId = (key: Buffer) =>
  createHash('sha256').update(key).digest('base64url').slice(0, 8);

/**
 * AES-256-GCM with associated data: `t1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url parts).
 * The context (church + connection) is authenticated, so a ciphertext only opens where it was
 * sealed. Older keys may be supplied for decryption during a key rotation; new values always use
 * the current key.
 */
export class AesGcmTokenCipher implements TokenCipherPort {
  private readonly current: { id: string; key: Buffer };
  private readonly keys = new Map<string, Buffer>();

  constructor(currentKey: string, previousKeys: string[] = []) {
    for (const encoded of [currentKey, ...previousKeys]) {
      const key = Buffer.from(encoded, 'base64');
      if (key.length !== 32)
        throw new Error('Token encryption keys must be 32 bytes');
      this.keys.set(keyId(key), key);
    }
    const key = Buffer.from(currentKey, 'base64');
    this.current = { id: keyId(key), key };
  }

  encrypt(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.current.key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return [
      VERSION,
      this.current.id,
      ...[iv, cipher.getAuthTag(), ciphertext].map((part) =>
        part.toString('base64url'),
      ),
    ].join('.');
  }

  decrypt(sealed: string, context: string): string {
    const [version, id, iv, tag, ciphertext] = sealed.split('.');
    if (version !== VERSION || !id || !iv || !tag || ciphertext === undefined)
      throw new Error('Unrecognised token envelope');
    const key = this.keys.get(id);
    if (!key) throw new Error('Token was sealed with an unknown key');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
