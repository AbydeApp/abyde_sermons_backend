import type { PrismaService } from '../../shared/infrastructure/prisma/prisma.service.js';
import {
  PrismaContentQuery,
  PrismaContentRepository,
  PrismaCalendarRepository,
} from '../content/content.repository.js';
import {
  PrismaSermonQuery,
  PrismaSermonRepository,
  PrismaTranscriptRepository,
  sermonWhere,
} from './sermons.repository.js';

/** Records every Prisma call so tests can assert that queries are always scoped by church_id. */
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
            return method === 'count'
              ? 0
              : method.startsWith('find') && method.endsWith('Many')
                ? []
                : method === 'groupBy'
                  ? []
                  : null;
          },
      },
    );
  const db = new Proxy({}, { get: (_target, name: string) => model(name) });
  return { prisma: { db } as unknown as PrismaService, calls };
}

const scoped = (where: Record<string, unknown> | undefined): boolean =>
  JSON.stringify(where ?? {}).includes('"churchId":"church-a"');

describe('Prisma adapters are church-scoped', () => {
  it('scopes every sermon read and write by churchId', async () => {
    const { prisma, calls } = recordingPrisma();
    const repo = new PrismaSermonRepository(prisma);
    const query = new PrismaSermonQuery(prisma);
    await repo.findById('church-a', 's1');
    await repo.findAssets('church-a', 's1');
    await repo.delete('church-a', 's1');
    await query.list('church-a', { q: 'faith' }, { page: 1, pageSize: 20 });
    await query.findViews('church-a', ['s1']);
    await query.matchingIds('church-a', {});
    await query.latest('church-a');
    for (const call of calls)
      expect({
        call: `${call.model}.${call.method}`,
        scoped: scoped(call.args.where),
      }).toEqual({ call: `${call.model}.${call.method}`, scoped: true });
    expect(calls.length).toBeGreaterThanOrEqual(7);
  });

  it('scopes transcript, content and calendar access by churchId', async () => {
    const { prisma, calls } = recordingPrisma();
    await new PrismaTranscriptRepository(prisma).listSegments('church-a', 's1');
    await new PrismaTranscriptRepository(prisma).findSegments('church-a', [
      'x',
    ]);
    await new PrismaContentRepository(prisma).findById('church-a', 'c1');
    await new PrismaContentRepository(prisma).delete('church-a', 'c1');
    await new PrismaContentRepository(prisma).listVersions('church-a', 'c1');
    await new PrismaContentQuery(prisma).list(
      'church-a',
      {},
      { page: 1, pageSize: 20 },
    );
    await new PrismaCalendarRepository(prisma).findById('church-a', 'k1');
    await new PrismaCalendarRepository(prisma).listRange(
      'church-a',
      new Date(),
      new Date(),
    );
    for (const call of calls)
      expect({
        call: `${call.model}.${call.method}`,
        scoped: scoped(call.args.where),
      }).toEqual({ call: `${call.model}.${call.method}`, scoped: true });
  });

  it('builds filters as parameterised Prisma conditions (no raw SQL from user input)', () => {
    const where = sermonWhere('church-a', {
      q: "'; DROP TABLE sermons; --",
      tag: 'Faith',
      year: 2026,
    });
    expect(JSON.stringify(where)).toContain(
      '"contains":"\'; DROP TABLE sermons; --"',
    );
    expect(JSON.stringify(where)).toContain('"has":"faith"');
  });
});
