/**
 * Framework-free error raised by domain and application code.
 * `kind` is a transport-neutral category; the HTTP layer maps it to a status code.
 */
export type DomainErrorKind =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'FORBIDDEN'
  | 'UNAUTHENTICATED'
  | 'PAYMENT_REQUIRED'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE';

export type FieldErrors = Record<string, string[]>;

export class DomainError extends Error {
  constructor(
    readonly kind: DomainErrorKind,
    readonly code: string,
    message: string,
    readonly fieldErrors: FieldErrors = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const notFound = (resource: string): DomainError =>
  new DomainError('NOT_FOUND', 'NOT_FOUND', `${resource} was not found.`);

export const validationError = (field: string, message: string): DomainError =>
  new DomainError(
    'UNPROCESSABLE',
    'VALIDATION_ERROR',
    'The request could not be processed.',
    {
      [field]: [message],
    },
  );

export const notReady = (
  message = 'This sermon is still being processed.',
): DomainError => new DomainError('CONFLICT', 'NOT_READY', message);
