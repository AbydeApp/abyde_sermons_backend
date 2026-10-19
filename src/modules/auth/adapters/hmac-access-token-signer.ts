import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../../shared/infrastructure/config/config.module.js';
import type { AppConfig } from '../../../shared/infrastructure/config/env.schema.js';
import type { AccessTokenClaims, AccessTokenSigner } from './access-token-signer.js';

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

/** HS256 JWT access tokens (`sub` = user id, `sid` = session id). */
@Injectable()
export class HmacAccessTokenSigner implements AccessTokenSigner {
  private readonly secret: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.secret = config.AUTH_ACCESS_TOKEN_SECRET;
  }

  sign(claims: AccessTokenClaims, issuedAt: Date, expiresAt: Date): string {
    const payload = Buffer.from(
      JSON.stringify({
        sub: claims.userId,
        sid: claims.sessionId,
        iat: Math.floor(issuedAt.getTime() / 1000),
        exp: Math.floor(expiresAt.getTime() / 1000),
      }),
    ).toString('base64url');
    return `${HEADER}.${payload}.${this.signature(`${HEADER}.${payload}`)}`;
  }

  verify(token: string, now: Date): AccessTokenClaims | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts as [string, string, string];
    if (header !== HEADER) return null; // pins the algorithm; nothing else is accepted
    const expected = Buffer.from(this.signature(`${header}.${payload}`));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      return null;
    try {
      const claims = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as { sub?: unknown; sid?: unknown; exp?: unknown };
      if (
        typeof claims.sub !== 'string' ||
        typeof claims.sid !== 'string' ||
        typeof claims.exp !== 'number' ||
        claims.exp * 1000 <= now.getTime()
      )
        return null;
      return { userId: claims.sub, sessionId: claims.sid };
    } catch {
      return null;
    }
  }

  private signature(data: string): string {
    return createHmac('sha256', this.secret).update(data).digest('base64url');
  }
}
