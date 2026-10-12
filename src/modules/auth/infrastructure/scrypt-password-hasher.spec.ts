import { ScryptPasswordHasher } from './scrypt-password-hasher.js';

// scrypt is deliberately slow (memory-hard); several hashes on a busy machine can exceed the 5s default.
describe('ScryptPasswordHasher', { timeout: 30_000 }, () => {
  const hasher = new ScryptPasswordHasher();

  it('hashes with a random salt and verifies', async () => {
    const hash = await hasher.hash('Faith2026!');
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(hash).not.toContain('Faith2026!');
    expect(await hasher.hash('Faith2026!')).not.toBe(hash);
    expect(await hasher.verify('Faith2026!', hash)).toBe(true);
    expect(await hasher.verify('faith2026!', hash)).toBe(false);
  });

  it('rejects malformed hashes without throwing', async () => {
    expect(await hasher.verify('x', 'garbage')).toBe(false);
    expect(await hasher.verify('x', '')).toBe(false);
  });
});
