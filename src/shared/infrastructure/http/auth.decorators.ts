import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthContext } from '../../application/auth-context.js';
import { DomainError } from '../../domain/domain-error.js';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext | null;
    rawBody?: Buffer;
  }
}

export const IS_PUBLIC = 'abyde:isPublic';
export const OPTIONAL_AUTH = 'abyde:optionalAuth';

/** Route needs no session (webhooks, health, register/login). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Route works signed in or out (`GET /auth/me`). */
export const OptionalAuth = () => SetMetadata(OPTIONAL_AUTH, true);

export const CurrentAuth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext | null => {
    return ctx.switchToHttp().getRequest<Request>().auth ?? null;
  },
);

/** Authenticated user's church id. Rejects users who have not finished onboarding. */
export const CurrentChurchId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const auth = ctx.switchToHttp().getRequest<Request>().auth;
    if (!auth)
      throw new DomainError(
        'UNAUTHENTICATED',
        'UNAUTHENTICATED',
        'Sign in to continue.',
      );
    if (!auth.churchId)
      throw new DomainError(
        'FORBIDDEN',
        'ONBOARDING_REQUIRED',
        'Create your church to continue.',
      );
    return auth.churchId;
  },
);

export const RequiredAuth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext => {
    const auth = ctx.switchToHttp().getRequest<Request>().auth;
    if (!auth)
      throw new DomainError(
        'UNAUTHENTICATED',
        'UNAUTHENTICATED',
        'Sign in to continue.',
      );
    return auth;
  },
);
