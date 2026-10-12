import {
  type ArgumentsHost,
  Catch,
  HttpException,
  Logger,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request, Response } from 'express';
import {
  DomainError,
  type DomainErrorKind,
} from '../../domain/domain-error.js';
import { DependencyUnavailableError } from '../resilience/dependency-guard.js';
import { reportError } from '../observability/error-reporter.js';

export interface ErrorEnvelope {
  statusCode: number;
  code: string;
  message: string;
  errors: Record<string, string[]>;
  requestId: string | null;
}

const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  402: 'PAYMENT_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'VALIDATION_ERROR',
  429: 'RATE_LIMITED',
  503: 'UNAVAILABLE',
};

const KIND_STATUS: Record<DomainErrorKind, number> = {
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  FORBIDDEN: 403,
  UNAUTHENTICATED: 401,
  PAYMENT_REQUIRED: 402,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
};

/**
 * Maps the errors this API knows (DomainError, HttpException, body-parser errors) to the single
 * error envelope. Anything else is delegated untouched to Nest's BaseExceptionFilter, which logs
 * it and answers with an opaque 500, so internals (stack traces, SQL, provider errors) never
 * reach clients. Registered with APP_FILTER so tests and production share it.
 */
@Catch()
export class ErrorEnvelopeFilter extends BaseExceptionFilter {
  private readonly log = new Logger(ErrorEnvelopeFilter.name);

  override catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') return super.catch(exception, host);
    const request = host.switchToHttp().getRequest<Request>();
    const requestId = typeof request.id === 'string' ? request.id : null;
    if (exception instanceof DependencyUnavailableError) {
      host
        .switchToHttp()
        .getResponse<Response>()
        .setHeader(
          'Retry-After',
          String(Math.max(1, exception.retryAfterSeconds)),
        );
    }
    const envelope = toEnvelope(exception, requestId);
    if (!envelope) {
      // Unknown error: report it, then let the base filter log it and send the opaque 500.
      reportError(exception, {
        requestId,
        route: request.route?.path as string | undefined,
      });
      return super.catch(exception, host);
    }
    if (envelope.statusCode >= 500) {
      this.log.error({ requestId, err: exception }, 'Request failed');
      reportError(exception, {
        requestId,
        route: request.route?.path as string | undefined,
      });
    }
    super.catch(new HttpException(envelope, envelope.statusCode), host);
  }
}

/** Returns the envelope for a recognised error, or null when the error is unknown. */
export function toEnvelope(
  exception: unknown,
  requestId: string | null,
): ErrorEnvelope | null {
  if (exception instanceof DomainError) {
    return {
      statusCode: KIND_STATUS[exception.kind],
      code: exception.code,
      message: exception.message,
      errors: exception.fieldErrors,
      requestId,
    };
  }
  if (exception instanceof HttpException) {
    const statusCode = exception.getStatus();
    const body = exception.getResponse();
    const record =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)
        : {};
    const code =
      typeof record.code === 'string'
        ? record.code
        : (STATUS_CODES[statusCode] ?? 'ERROR');
    const errors = isFieldErrors(record.errors) ? record.errors : {};
    const message =
      statusCode === 500
        ? 'Something went wrong.'
        : typeof record.message === 'string'
          ? record.message
          : exception.message;
    return { statusCode, code, message, errors, requestId };
  }
  if (exception instanceof DependencyUnavailableError) {
    return {
      statusCode: 503,
      code: 'UNAVAILABLE',
      message:
        'A service we depend on is temporarily unavailable. Please try again shortly.',
      errors: {},
      requestId,
    };
  }
  const parserError = exception as { type?: string };
  if (parserError?.type === 'entity.parse.failed') {
    return {
      statusCode: 400,
      code: 'BAD_REQUEST',
      message: 'The request body is not valid JSON.',
      errors: {},
      requestId,
    };
  }
  if (parserError?.type === 'entity.too.large') {
    return {
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'The request body is too large.',
      errors: {},
      requestId,
    };
  }
  return null;
}

function isFieldErrors(value: unknown): value is Record<string, string[]> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every(
      (messages) =>
        Array.isArray(messages) && messages.every((m) => typeof m === 'string'),
    )
  );
}
