import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { Logger } from 'nestjs-pino';
import type { AppConfig } from './shared/infrastructure/config/env.schema.js';
import { ROUTE_LIMIT_SETTINGS } from './shared/infrastructure/http/route-limits.js';

export const API_PREFIX = 'api/v1';

const transcriptBodyParser = express.json({ limit: '2mb' });

/** Shared by main.ts and e2e tests so both run the same HTTP pipeline. */
export function configureApp(
  app: NestExpressApplication,
  config: AppConfig,
): void {
  app.useLogger(app.get(Logger));
  app.set('trust proxy', config.APP_TRUST_PROXY_HOPS);
  app.set(ROUTE_LIMIT_SETTINGS.auth, config.AUTH_RATE_LIMIT_MAX);
  app.set(ROUTE_LIMIT_SETTINGS.ai, config.APP_AI_RATE_LIMIT_MAX);
  // Security headers on every response (routes, 404s and errors). This API only serves JSON, so
  // the Content-Security-Policy allows nothing; Swagger UI (never in production) needs the default.
  app.useSecurityHeaders({
    contentSecurityPolicy: config.swaggerEnabled
      ? true
      : {
          useDefaults: false,
          directives: {
            'default-src': ["'none'"],
            'frame-ancestors': ["'none'"],
          },
        },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  // Cross-site request forgery: state-changing requests from other origins are rejected unless
  // the origin is one of the web app's. Non-browser callers (webhooks) send no Origin and pass.
  app.enableCsrfProtection({ trustedOrigins: config.APP_CORS_ORIGINS });
  // The global JSON limit stays at the 100 KB default. Only sermon creation, which accepts a
  // pasted transcript, gets a larger limit, on that route alone.
  app.use(
    `/${API_PREFIX}/sermons`,
    (req: Request, res: Response, next: NextFunction) =>
      req.method === 'POST' && req.path === '/'
        ? transcriptBodyParser(req, res, next)
        : next(),
  );
  app.use(cookieParser());
  app.enableCors({
    origin: config.APP_CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Idempotent-Replayed', 'Retry-After'],
    maxAge: 600,
  });
  app.setGlobalPrefix(API_PREFIX, {
    exclude: ['health', 'health/ready', 'metrics'],
  });
  app.enableShutdownHooks();

  if (config.swaggerEnabled) {
    const document = SwaggerModule.createDocument(
      app as INestApplication,
      new DocumentBuilder()
        .setTitle('Abyde Sermon API')
        .setVersion('1')
        .addCookieAuth(config.AUTH_COOKIE_NAME)
        .build(),
    );
    SwaggerModule.setup('docs', app, document);
  }
}
