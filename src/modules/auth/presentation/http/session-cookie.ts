import type { CookieOptions, Request, Response } from 'express';

export interface SessionCookieSettings {
  name: string;
  domain?: string;
  secure: boolean;
}

export const SESSION_COOKIE_SETTINGS = Symbol('SESSION_COOKIE_SETTINGS');

const baseOptions = (settings: SessionCookieSettings): CookieOptions => ({
  httpOnly: true,
  secure: settings.secure,
  sameSite: 'lax',
  path: '/',
  domain: settings.domain,
});

export function setSessionCookie(
  res: Response,
  settings: SessionCookieSettings,
  token: string,
  expiresAt: Date,
): void {
  res.cookie(settings.name, token, {
    ...baseOptions(settings),
    expires: expiresAt,
  });
}

export function clearSessionCookie(
  res: Response,
  settings: SessionCookieSettings,
): void {
  res.clearCookie(settings.name, baseOptions(settings));
}

export function readSessionCookie(
  req: Request,
  settings: SessionCookieSettings,
): string | undefined {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[settings.name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
