import { MetaPagePublisher } from './publishing-providers.js';

const input = {
  idempotencyKey: 'k',
  credentials: { pageId: 'p1', pageAccessToken: 't' },
  content: { type: 'SOCIAL_POST' as const, title: 'T', body: 'Body' },
};
const respond = (status: number, body: object) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('MetaPagePublisher failure classification', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports success with the provider id', async () => {
    vi.stubGlobal('fetch', respond(200, { id: 'post-1' }));
    expect(await new MetaPagePublisher('v21.0').publish(input)).toEqual({
      ok: true,
      externalId: 'post-1',
    });
  });

  it('treats 4xx as a definite rejection (429 retryable, 401 needs reconnecting)', async () => {
    vi.stubGlobal('fetch', respond(400, { error: { message: 'bad' } }));
    expect(await new MetaPagePublisher('v21.0').publish(input)).toMatchObject({
      ok: false,
      definite: true,
      retryable: false,
    });
    vi.stubGlobal('fetch', respond(429, {}));
    expect(await new MetaPagePublisher('v21.0').publish(input)).toMatchObject({
      definite: true,
      retryable: true,
    });
    vi.stubGlobal('fetch', respond(401, {}));
    expect(await new MetaPagePublisher('v21.0').publish(input)).toMatchObject({
      definite: true,
      credentialsInvalid: true,
    });
  });

  it('treats 5xx and network errors as outcome-unknown, which is never retried', async () => {
    vi.stubGlobal('fetch', respond(502, {}));
    expect(await new MetaPagePublisher('v21.0').publish(input)).toMatchObject({
      ok: false,
      definite: false,
      retryable: false,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('socket hang up'))),
    );
    expect(await new MetaPagePublisher('v21.0').publish(input)).toMatchObject({
      ok: false,
      definite: false,
      retryable: false,
    });
  });

  it('does not call the provider without credentials', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await new MetaPagePublisher('v21.0').publish({
        ...input,
        credentials: {},
      }),
    ).toMatchObject({ ok: false, definite: true, credentialsInvalid: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
