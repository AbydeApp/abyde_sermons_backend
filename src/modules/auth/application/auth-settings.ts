export const AUTH_SETTINGS = Symbol('AUTH_SETTINGS');

export interface AuthSettings {
  sessionTtlHours: number;
  rememberTtlDays: number;
  resetTokenTtlMinutes: number;
  webUrl: string;
}
