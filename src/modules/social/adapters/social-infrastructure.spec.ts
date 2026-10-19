import { createHash } from 'node:crypto';
import { FakeSocialAdapter } from '../../../../test/support/social-fakes.js';
import { AesGcmTokenCipher } from '../../../shared/infrastructure/crypto/aes-gcm-token-cipher.js';
import type { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service.js';
import { SOCIAL_PROVIDERS } from '../helper.js';
import {
  PrismaSocialConnectionRepository,
  PrismaSocialPostRepository,
} from '../social.repository.js';
import { SocialProviderRegistry } from './social-provider.registry.js';

const key = (seed: string) =>
  createHash('sha256').update(seed).digest('base64');

describe('AesGcmTokenCipher', () => {
  const cipher = new AesGcmTokenCipher(key('current'));

  it('round-trips and never stores the plaintext', () => {
    const sealed = cipher.encrypt(
      'EAAB-secret-token',
      'social:c1:conn1:access',
    );
    expect(sealed).toMatch(/^t1\./);
    expect(sealed).not.toContain('secret');
    expect(cipher.decrypt(sealed, 'social:c1:conn1:access')).toBe(
      'EAAB-secret-token',
    );
  });

  it('binds the ciphertext to its church and connection', () => {
    const sealed = cipher.encrypt('token', 'social:c1:conn1:access');
    expect(() => cipher.decrypt(sealed, 'social:c2:conn1:access')).toThrow();
    expect(() => cipher.decrypt(sealed, 'social:c1:conn2:access')).toThrow();
    const parts = sealed.split('.');
    parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() =>
      cipher.decrypt(parts.join('.'), 'social:c1:conn1:access'),
    ).toThrow();
  });

  it('decrypts with retired keys during a rotation and encrypts with the new one', () => {
    const old = new AesGcmTokenCipher(key('old'));
    const sealed = old.encrypt('token', 'ctx');
    const rotated = new AesGcmTokenCipher(key('new'), [key('old')]);
    expect(rotated.decrypt(sealed, 'ctx')).toBe('token');
    expect(() =>
      new AesGcmTokenCipher(key('new')).decrypt(sealed, 'ctx'),
    ).toThrow(/unknown key/);
    // New values use the new key, which the old cipher cannot open.
    expect(() => old.decrypt(rotated.encrypt('x', 'ctx'), 'ctx')).toThrow();
  });

  it('rejects keys of the wrong length', () => {
    expect(
      () => new AesGcmTokenCipher(Buffer.alloc(16).toString('base64')),
    ).toThrow();
  });
});

describe('SocialProviderRegistry', () => {
  const adapters = SOCIAL_PROVIDERS.map(
    (provider) => new FakeSocialAdapter(provider),
  );

  it('resolves platforms to their provider adapter', () => {
    const registry = new SocialProviderRegistry(adapters);
    expect(registry.forPlatform('facebook').provider).toBe('meta');
    expect(registry.forPlatform('instagram').provider).toBe('meta');
    expect(registry.forPlatform('youtube').provider).toBe('youtube');
    expect(registry.forPlatform('x').provider).toBe('x');
    expect(registry.all().map((adapter) => adapter.provider)).toEqual([
      ...SOCIAL_PROVIDERS,
    ]);
  });

  it('refuses an incomplete set of adapters at boot', () => {
    expect(() => new SocialProviderRegistry(adapters.slice(1))).toThrow(/meta/);
  });
});

/** Records Prisma calls so tests can assert every query is scoped by church_id. */
function recordingPrisma() {
  const calls: Array<{
    model: string;
    method: string;
    args: { where?: Record<string, unknown> };
  }> = [];
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get:
          (_target, method: string) =>
          async (args: { where?: Record<string, unknown> }) => {
            calls.push({ model: name, method, args });
            if (method === 'count') return 0;
            if (method === 'updateMany' || method === 'deleteMany')
              return { count: 0 };
            return method === 'findMany' ? [] : null;
          },
      },
    );
  const db = new Proxy({}, { get: (_target, name: string) => model(name) });
  return { prisma: { db } as unknown as PrismaService, calls };
}

describe('Prisma social adapters are church-scoped', () => {
  it('scopes every tenant read and write by churchId', async () => {
    const { prisma, calls } = recordingPrisma();
    const connections = new PrismaSocialConnectionRepository(prisma);
    const posts = new PrismaSocialPostRepository(prisma);
    await connections.list('church-a');
    await connections.findById('church-a', 'x');
    await connections.findByIds('church-a', ['x']);
    await connections.findByAccount('church-a', 'facebook', 'p1');
    await connections.countConnectedByGrant('church-a', 'g', 'x');
    await posts.find('church-a', 'x');
    await posts.list('church-a', {}, { page: 1, pageSize: 20 });
    await posts.delete('church-a', 'x');
    await posts.findPublication('church-a', 'x');
    await posts.transitionPublication('church-a', 'x', ['queued'], {
      status: 'publishing',
    });
    await posts.replacePublications('church-a', 'x', []);
    await posts.saveMetrics('church-a', 'x', {}, new Date());
    for (const call of calls)
      expect({
        call: `${call.model}.${call.method}`,
        scoped: JSON.stringify(call.args.where ?? {}).includes(
          '"churchId":"church-a"',
        ),
      }).toEqual({
        call: `${call.model}.${call.method}`,
        scoped: true,
      });
    expect(calls.length).toBeGreaterThanOrEqual(12);
  });
});
