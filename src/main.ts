import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import { APP_CONFIG } from './shared/infrastructure/config/config.module.js';
import type { AppConfig } from './shared/infrastructure/config/env.schema.js';
import { crashOnFatalErrors } from './shared/infrastructure/observability/fatal-errors.js';

/** API process: serves HTTP and enqueues work. It never runs transcription/AI jobs itself. */
async function bootstrap() {
  crashOnFatalErrors();
  // Creating the app validates the environment (ConfigModule); invalid config throws here.
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(),
    {
      bufferLogs: true,
      rawBody: true,
    },
  );
  const config = app.get<AppConfig>(APP_CONFIG);
  configureApp(app, config);
  await app.listen(config.APP_PORT);
}
await bootstrap();
