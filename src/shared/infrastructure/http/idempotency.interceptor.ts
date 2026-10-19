import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { CACHE, type CachePort } from '../../application/ports/cache.port.js';
import { DomainError } from '../../domain/domain-error.js';
import { toEnvelope } from './error-envelope.filter.js';

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const RESULT_TTL_SECONDS = 24 * 3600;
const LOCK_TTL_SECONDS = 120;
const RETRY_AFTER_SECONDS = 2;
const KEY_PATTERN = /^[A-Za-z0-9_\-:.]{8,128}$/;
const REQUIRE_IDEMPOTENCY_KEY = 'abyde:requireIdempotencyKey';

/**
 * Marks an endpoint that must never run twice (payments, anything that sends a message):
 * requests without an `Idempotency-Key` header are rejected.
 */
export const RequireIdempotencyKey = () =>
  SetMetadata(REQUIRE_IDEMPOTENCY_KEY, true);

interface StoredResult {
  fingerprint: string;
  status: number;
  body: unknown;
  isError: boolean;
}

/**
 * Idempotent writes, backed by the shared cache (Redis), never process memory.
 *
 * - Keys are scoped per user (or per client IP on public routes) and per route, so two clients can
 *   never collide or read each other's stored results.
 * - Same key + same body: the stored response is replayed without running the handler.
 * - Same key + different body: 422.
 * - A duplicate while the first is still running: 409 with `Retry-After`.
 * - Responses below 500 are stored (including 4xx); 5xx are not, so a server-side failure can be retried.
 * - Routes that receive passwords are never stored (see `isPasswordRoute`).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    if (!MUTATING.has(request.method)) return next.handle();

    const required = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_IDEMPOTENCY_KEY,
      [context.getHandler(), context.getClass()],
    );
    const header = request.headers['idempotency-key'];
    if (typeof header !== 'string') {
      if (required) {
        throw new DomainError(
          'UNPROCESSABLE',
          'IDEMPOTENCY_KEY_REQUIRED',
          'This request needs an Idempotency-Key header.',
        );
      }
      return next.handle();
    }
    // Bodies containing passwords are never stored, not even as a hash; a replay could not
    // re-issue the tokens anyway.
    if (!required && isPasswordRoute(request.path)) return next.handle();
    if (!KEY_PATTERN.test(header)) {
      throw new DomainError(
        'UNPROCESSABLE',
        'INVALID_IDEMPOTENCY_KEY',
        'Idempotency-Key must be 8–128 URL-safe characters.',
      );
    }
    return from(this.run(request, response, header, next));
  }

  private async run(
    request: Request,
    response: Response,
    header: string,
    next: CallHandler,
  ): Promise<unknown> {
    const scope = request.auth?.userId ?? `ip:${request.ip ?? 'unknown'}`;
    const key = createHash('sha256')
      .update(`${scope}|${request.method}|${request.originalUrl}|${header}`)
      .digest('hex');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(request.body ?? null))
      .digest('hex');
    const resultKey = `idempotency:result:${key}`;
    const lockKey = `idempotency:lock:${key}`;

    const stored = await this.cache.get<StoredResult>(resultKey);
    if (stored) return this.replay(stored, fingerprint, response);

    if (!(await this.cache.setIfAbsent(lockKey, 1, LOCK_TTL_SECONDS))) {
      response.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
      throw new DomainError(
        'CONFLICT',
        'IDEMPOTENCY_IN_PROGRESS',
        'An identical request is still being processed.',
      );
    }
    try {
      const body: unknown = await lastValueFrom(next.handle(), {
        defaultValue: undefined,
      });
      await this.cache.set<StoredResult>(
        resultKey,
        {
          fingerprint,
          status: response.statusCode,
          body: body ?? null,
          isError: false,
        },
        RESULT_TTL_SECONDS,
      );
      return body;
    } catch (error) {
      // Client errors are final for this key; server errors (and unknown errors) are not stored.
      const envelope = toEnvelope(error, null);
      if (envelope && envelope.statusCode < 500) {
        await this.cache.set<StoredResult>(
          resultKey,
          {
            fingerprint,
            status: envelope.statusCode,
            body: envelope,
            isError: true,
          },
          RESULT_TTL_SECONDS,
        );
      }
      throw error;
    } finally {
      await this.cache.del(lockKey);
    }
  }

  private replay(
    stored: StoredResult,
    fingerprint: string,
    response: Response,
  ): unknown {
    if (stored.fingerprint !== fingerprint) {
      throw new DomainError(
        'UNPROCESSABLE',
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different request.',
      );
    }
    response.setHeader('Idempotent-Replayed', 'true');
    if (stored.isError)
      throw new HttpException(stored.body as object, stored.status);
    response.status(stored.status);
    return stored.body;
  }
}

/** Auth routes whose bodies carry a password. */
function isPasswordRoute(path: string): boolean {
  return /\/auth\/(register|login|change-password|reset-password|me)$/.test(
    path,
  );
}
