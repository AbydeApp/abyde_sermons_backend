import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { crashOnFatalErrors } from './shared/infrastructure/observability/fatal-errors.js';
import { BullMqWorkerHost } from './shared/infrastructure/queue/bullmq-worker.host.js';

/**
 * Worker process: same modules and use cases as the API, no HTTP server. Consumes BullMQ queues
 * (transcription, analysis, embeddings, content generation, publishing, email, maintenance).
 * Deploy and scale independently of the API.
 */
async function bootstrap() {
  crashOnFatalErrors();
  const app = await NestFactory.createApplicationContext(
    AppModule.register({ extraProviders: [BullMqWorkerHost] }),
    { bufferLogs: true },
  );
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
}
await bootstrap();
