import { validationError } from '../../../shared/domain/domain-error.js';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export function assertPasswordPolicy(
  password: string,
  field = 'password',
): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw validationError(
      field,
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    );
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw validationError(
      field,
      `Password must be at most ${PASSWORD_MAX_LENGTH} characters`,
    );
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw validationError(field, 'Password must contain letters and numbers');
  }
}
