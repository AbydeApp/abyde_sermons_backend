import { validationError } from '../../../shared/domain/domain-error.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Emails are compared and stored normalized: trimmed and lower-cased. */
export function normalizeEmail(raw: string, field = 'email'): string {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw validationError(field, 'Enter a valid email address');
  }
  return email;
}
