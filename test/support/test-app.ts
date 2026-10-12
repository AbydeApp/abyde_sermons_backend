import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/bootstrap.js';
import { APP_CONFIG } from '../../src/shared/infrastructure/config/config.module.js';
import type { AppConfig } from '../../src/shared/infrastructure/config/env.schema.js';
import { TestInfrastructure } from './test-infrastructure.js';

export const TEST_ENV: Record<string, string> = {
  APP_ENV: 'test',
  APP_LOG_LEVEL: 'silent',
  APP_CORS_ORIGINS: 'http://web.test',
  APP_WEB_URL: 'http://web.test',
  APP_RATE_LIMIT_MAX: '10000',
  AUTH_RATE_LIMIT_MAX: '10000',
  APP_AI_RATE_LIMIT_MAX: '10000',
  DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused',
  REDIS_URL: 'redis://localhost:6379',
  // Storage is replaced by the in-memory double; these only satisfy env validation.
  STORAGE_ACCESS_KEY_ID: 'test',
  STORAGE_SECRET_ACCESS_KEY: 'test',
  APP_SHUTDOWN_DRAIN_MS: '0',
};

export interface TestApp {
  app: NestExpressApplication;
  infra: TestInfrastructure;
  close(): Promise<void>;
}

/** Boots the real AppModule (all controllers, guards, pipes, filters) over in-memory infrastructure. */
export async function createTestApp(
  env: Record<string, string> = {},
): Promise<TestApp> {
  Object.assign(process.env, TEST_ENV, env);
  const infra = new TestInfrastructure();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register({ infrastructure: [infra.module()] })],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true,
    logger: false,
  });
  configureApp(app, app.get<AppConfig>(APP_CONFIG));
  await app.init();
  return { app, infra, close: () => app.close() };
}

/** Cookie-preserving HTTP client for one signed-in user. */
export class Client {
  private cookie = '';
  email = '';

  constructor(private readonly testApp: TestApp) {}

  private send(
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    body?: object,
    headers: Record<string, string> = {},
  ) {
    let req = request(this.testApp.app.getHttpServer())
      [method](`/api/v1${path}`)
      .set('Origin', 'http://web.test');
    if (this.cookie) req = req.set('Cookie', this.cookie);
    for (const [key, value] of Object.entries(headers))
      req = req.set(key, value);
    req.on('response', (response: { headers: Record<string, unknown> }) => {
      const setCookie = response.headers['set-cookie'] as string[] | undefined;
      if (setCookie?.[0]) this.cookie = setCookie[0].split(';')[0] ?? '';
    });
    return body ? req.send(body) : req;
  }

  get = (path: string, headers?: Record<string, string>) =>
    this.send('get', path, undefined, headers);
  post = (path: string, body: object = {}, headers?: Record<string, string>) =>
    this.send('post', path, body, headers);
  put = (path: string, body: object, headers?: Record<string, string>) =>
    this.send('put', path, body, headers);
  patch = (path: string, body: object, headers?: Record<string, string>) =>
    this.send('patch', path, body, headers);
  delete = (path: string, headers?: Record<string, string>) =>
    this.send('delete', path, undefined, headers);

  /** Registers and creates a church; returns the church id. */
  async onboard(name: string): Promise<string> {
    const email = `${name.toLowerCase().replace(/\W+/g, '-')}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    this.email = email;
    await this.post('/auth/register', {
      fullName: `${name} Pastor`,
      email,
      password: 'Faith2026!',
    }).expect(201);
    const me = await this.post('/church', {
      name,
      ownerRole: 'Lead Pastor',
    }).expect(201);
    return (me.body as { church: { id: string } }).church.id;
  }

  login() {
    return this.post('/auth/login', {
      email: this.email,
      password: 'Faith2026!',
    }).expect(200);
  }

  /** Uploads media through the presign flow and creates a sermon; returns its id (processing not yet run). */
  async createSermon(
    title = 'Walking By Faith',
    extra: object = {},
  ): Promise<string> {
    const audio = Buffer.from('fake-mp3-bytes');
    const presign = await this.post('/uploads/presign', {
      fileName: 'sermon.mp3',
      contentType: 'audio/mpeg',
      sizeBytes: audio.length,
      purpose: 'SERMON_MEDIA',
    }).expect(200);
    const { objectKey } = presign.body as { objectKey: string };
    this.testApp.infra.storage.put(objectKey, audio, 'audio/mpeg');
    const created = await this.post('/sermons', {
      title,
      speaker: 'Pastor Ade',
      sermonDate: '2026-09-27T09:00:00Z',
      mainScripture: '2 Corinthians 5:7',
      objectKey,
      ...extra,
    }).expect(202);
    return (created.body as { id: string }).id;
  }

  /** Creates a sermon and runs the whole processing pipeline to READY. */
  async readySermon(title?: string): Promise<string> {
    const id = await this.createSermon(title);
    await this.testApp.infra.queue.drain();
    return id;
  }
}
