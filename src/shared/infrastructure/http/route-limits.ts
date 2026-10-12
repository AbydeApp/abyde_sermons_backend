import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Per-route rate limits read from app settings (configured in bootstrap from validated env). */
const setting =
  (name: string, fallback: number) =>
  (context: ExecutionContext): number => {
    const value: unknown = context
      .switchToHttp()
      .getRequest<Request>()
      .app.get(name);
    return typeof value === 'number' ? value : fallback;
  };

export const ROUTE_LIMIT_SETTINGS = {
  auth: 'abyde.authRateLimit',
  ai: 'abyde.aiRateLimit',
} as const;

/** Credential endpoints (login, register, reset): strict per-IP budget. */
export const CREDENTIAL_THROTTLE = {
  default: { limit: setting(ROUTE_LIMIT_SETTINGS.auth, 10), ttl: 60_000 },
};

/** AI-backed endpoints (semantic search, ask): tighter budget than the global default. */
export const AI_THROTTLE = {
  default: { limit: setting(ROUTE_LIMIT_SETTINGS.ai, 20), ttl: 60_000 },
};
