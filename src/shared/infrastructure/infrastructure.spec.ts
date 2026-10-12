import { z } from 'zod';
import { DomainError } from '../domain/domain-error.js';
import {
  InvalidModelOutputError,
  type LanguageModelPort,
} from '../application/ports/language-model.port.js';
import { toStrictJsonSchema } from './ai/strict-json-schema.js';
import { MeteredLanguageModel } from './ai/metered-language-model.js';
import { reportTokenUsage } from './ai/token-usage.js';
import { AesGcmSecretBox } from './crypto/aes-gcm-secret-box.js';
import { toEnvelope } from './http/error-envelope.filter.js';
import { InMemoryCacheAdapter } from '../../../test/support/in-memory-cache.adapter.js';
import { JobHandlerRegistry, PermanentJobError } from '../application/jobs.js';
import { InMemoryQueueAdapter } from '../../../test/support/in-memory-queue.adapter.js';

describe('toStrictJsonSchema', () => {
  it('closes objects, requires every key and strips unsupported keywords', () => {
    const schema = toStrictJsonSchema(
      z.object({
        title: z.string().min(1).max(10),
        note: z.string().nullable(),
        items: z.array(z.object({ n: z.number().int() })).max(3),
      }),
    );
    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['title', 'note', 'items'],
    });
    expect(JSON.stringify(schema)).not.toMatch(
      /minLength|maxLength|maxItems|\$schema/,
    );
    expect(
      (schema.properties as Record<string, { items: object }>).items.items,
    ).toMatchObject({ additionalProperties: false, required: ['n'] });
  });
});

describe('AesGcmSecretBox', () => {
  const box = new AesGcmSecretBox(Buffer.alloc(32, 1).toString('base64'));

  it('round-trips and never stores plaintext', () => {
    const sealed = box.seal('{"token":"secret"}');
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain('secret');
    expect(box.open(sealed)).toBe('{"token":"secret"}');
    expect(box.seal('same')).not.toBe(box.seal('same')); // random IV
  });

  it('detects tampering and wrong keys', () => {
    const sealed = box.seal('payload');
    const tampered =
      sealed.slice(0, -2) +
      (sealed.endsWith('A') ? 'B' : 'A') +
      sealed.slice(-1);
    expect(() => box.open(tampered)).toThrow();
    expect(() =>
      new AesGcmSecretBox(Buffer.alloc(32, 2).toString('base64')).open(sealed),
    ).toThrow();
  });
});

describe('MeteredLanguageModel', () => {
  it('records cost and usage per call without prompts, and still records failures', async () => {
    const recorded: unknown[] = [];
    const metered: unknown[] = [];
    const inner: LanguageModelPort = {
      generateStructured: async () => {
        reportTokenUsage(1000, 500);
        return { data: { ok: true } as never, provider: 'x', model: 'm-1' };
      },
      embed: async () => {
        throw new Error('down');
      },
    };
    const model = new MeteredLanguageModel(
      inner,
      'x',
      { text: 'm', embedding: 'e' },
      { textInputPerMTok: 1, textOutputPerMTok: 2, embeddingPerMTok: 0 },
      {
        record: async (e) => void recorded.push(e),
        deleteBefore: async () => 0,
      },
      { record: async (u) => void metered.push(u) },
    );
    await model.generateStructured({
      context: { operation: 'op', churchId: 'c1' },
      schemaName: 's',
      schema: z.object({}),
      system: 'secret system',
      prompt: 'secret prompt',
      input: {},
    });
    await expect(
      model.embed({
        context: { operation: 'embed', churchId: 'c1' },
        inputs: ['x'],
      }),
    ).rejects.toThrow('down');
    expect(recorded).toEqual([
      expect.objectContaining({
        operation: 'op',
        model: 'm-1',
        inputTokens: 1000,
        outputTokens: 500,
        estimatedCost: 0.002,
        status: 'SUCCEEDED',
      }),
      expect.objectContaining({ operation: 'embed', status: 'FAILED' }),
    ]);
    expect(JSON.stringify(recorded)).not.toContain('secret');
    expect(metered).toEqual([
      expect.objectContaining({ churchId: 'c1', unit: 'TEXT_GENERATION' }),
    ]);
  });
});

describe('error envelope mapping', () => {
  it('maps domain errors to statuses and leaves unknown errors to the base filter', () => {
    expect(
      toEnvelope(
        new DomainError('PAYMENT_REQUIRED', 'PLAN_LIMIT_REACHED', 'Upgrade'),
        'r1',
      ),
    ).toEqual({
      statusCode: 402,
      code: 'PLAN_LIMIT_REACHED',
      message: 'Upgrade',
      errors: {},
      requestId: 'r1',
    });
    // Unknown errors are not mapped here: the filter delegates them to Nest's base filter (opaque 500).
    expect(
      toEnvelope(new Error('SELECT * FROM users failed: password=...'), 'r2'),
    ).toBeNull();
  });
});

describe('InMemoryCacheAdapter', () => {
  it('supports TTL, set-if-absent, single-use take and counters', async () => {
    let now = 0;
    const cache = new InMemoryCacheAdapter(() => now);
    expect(await cache.setIfAbsent('k', 1, 10)).toBe(true);
    expect(await cache.setIfAbsent('k', 2, 10)).toBe(false);
    expect(await cache.take('k')).toBe(1);
    expect(await cache.get('k')).toBeNull();
    expect(await cache.increment('n', 5)).toBe(1);
    expect(await cache.increment('n', 5)).toBe(2);
    now = 6000;
    expect(await cache.increment('n', 5)).toBe(1);
  });
});

describe('InMemoryQueueAdapter', () => {
  it('retries with the queue policy and stops on permanent errors', async () => {
    const registry = new JobHandlerRegistry();
    const queue = new InMemoryQueueAdapter(registry);
    let flakyCalls = 0;
    let permanentCalls = 0;
    registry.register({
      queue: 'email',
      jobName: 'flaky',
      handle: async () => {
        flakyCalls++;
        if (flakyCalls < 3) throw new Error('transient');
      },
    });
    registry.register({
      queue: 'email',
      jobName: 'bad',
      handle: async () => {
        permanentCalls++;
        throw new PermanentJobError('no');
      },
    });
    await queue.enqueue('email', 'flaky', {}, { jobId: 'a' });
    await queue.enqueue('email', 'flaky', {}, { jobId: 'a' }); // deduplicated
    await queue.enqueue('email', 'bad', {});
    await queue.drain();
    expect(flakyCalls).toBe(3);
    expect(permanentCalls).toBe(1);
    expect(queue.jobs.map((job) => job.state)).toEqual(['completed', 'failed']);
  });
});

describe('InvalidModelOutputError', () => {
  it('names the schema that failed', () => {
    expect(
      new InvalidModelOutputError('sermon_analysis', 'bad').message,
    ).toContain('sermon_analysis');
  });
});
