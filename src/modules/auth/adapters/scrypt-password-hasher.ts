import {
  randomBytes,
  scrypt,
  type ScryptOptions,
  timingSafeEqual,
} from 'node:crypto';
import type { PasswordHasher } from './password-hasher.js';

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const MAX_MEM = 128 * N * R * 2;

function derive(
  password: string,
  salt: Buffer,
  length: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, length, options, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}

/** Memory-hard scrypt hashing (OWASP-recommended parameters), encoded as `scrypt$N$r$p$salt$hash`. */
export class ScryptPasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await derive(password, salt, KEY_LENGTH, {
      N,
      r: R,
      p: P,
      maxmem: MAX_MEM,
    });
    return [
      'scrypt',
      N,
      R,
      P,
      salt.toString('base64url'),
      key.toString('base64url'),
    ].join('$');
  }

  async verify(password: string, encoded: string): Promise<boolean> {
    const [scheme, n, r, p, saltPart, hashPart] = encoded.split('$');
    const params = { N: Number(n), r: Number(r), p: Number(p) };
    const expected = Buffer.from(hashPart ?? '', 'base64url');
    const salt = Buffer.from(saltPart ?? '', 'base64url');
    const valid =
      scheme === 'scrypt' &&
      expected.length > 0 &&
      salt.length > 0 &&
      Object.values(params).every(Number.isFinite);
    // Always run the KDF so malformed/unknown hashes take the same time as real ones.
    const key = await derive(
      password,
      valid ? salt : Buffer.alloc(16),
      valid ? expected.length : KEY_LENGTH,
      {
        ...(valid ? params : { N, r: R, p: P }),
        maxmem: MAX_MEM,
      },
    );
    return valid && timingSafeEqual(key, expected);
  }
}
