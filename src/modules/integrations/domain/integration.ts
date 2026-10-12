export const INTEGRATION_PROVIDERS = [
  'META',
  'WHATSAPP',
  'EMAIL',
  'YOUTUBE',
] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];
export type IntegrationStatus =
  'NOT_CONNECTED' | 'CONNECTED' | 'NEEDS_ATTENTION';

export interface IntegrationRecord {
  id: string;
  churchId: string;
  provider: IntegrationProvider;
  status: IntegrationStatus;
  /** Sealed (encrypted) credential blob; never leaves the server. */
  encryptedCredentials: string | null;
  externalAccountId: string | null;
  accountLabel: string | null;
  expiresAt: Date | null;
}

export const isIntegrationProvider = (
  value: string,
): value is IntegrationProvider =>
  (INTEGRATION_PROVIDERS as readonly string[]).includes(value);
