import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  IS_PUBLIC,
  OPTIONAL_AUTH,
} from '../../shared/infrastructure/http/auth.decorators.js';
import { AuthService } from './auth.service.js';
import { readBearerToken, unauthenticated } from './helper.js';

/** Global guard: every route requires a valid access token unless marked @Public() or @OptionalAuth(). */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets))
      return true;
    const request = context.switchToHttp().getRequest<Request>();
    const token = readBearerToken(request);
    request.auth = token ? await this.auth.resolveAccessToken(token) : null;
    if (
      request.auth ||
      this.reflector.getAllAndOverride<boolean>(OPTIONAL_AUTH, targets)
    )
      return true;
    throw unauthenticated();
  }
}
