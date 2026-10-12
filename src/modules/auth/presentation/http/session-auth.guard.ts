import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DomainError } from '../../../../shared/domain/domain-error.js';
import {
  IS_PUBLIC,
  OPTIONAL_AUTH,
} from '../../../../shared/infrastructure/http/auth.decorators.js';
import { ResolveSessionUseCase } from '../../application/use-cases/resolve-session.use-case.js';
import {
  readSessionCookie,
  SESSION_COOKIE_SETTINGS,
  type SessionCookieSettings,
} from './session-cookie.js';

/** Global guard: every route requires a valid session unless marked @Public() or @OptionalAuth(). */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ResolveSessionUseCase)
    private readonly resolveSession: ResolveSessionUseCase,
    @Inject(SESSION_COOKIE_SETTINGS)
    private readonly cookie: SessionCookieSettings,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets))
      return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = readSessionCookie(request, this.cookie);
    request.auth = token ? await this.resolveSession.execute(token) : null;
    if (
      request.auth ||
      this.reflector.getAllAndOverride<boolean>(OPTIONAL_AUTH, targets)
    )
      return true;
    throw new DomainError(
      'UNAUTHENTICATED',
      'UNAUTHENTICATED',
      'Sign in to continue.',
    );
  }
}
