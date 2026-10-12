import { type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { DomainError, type FieldErrors } from '../../domain/domain-error.js';

/** Validates transport input against a Zod schema and emits the 422 error envelope shape. */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value ?? {});
    if (result.success) {
      return result.data;
    }
    const errors: FieldErrors = {};
    for (const issue of result.error.issues) {
      const field = issue.path.join('.') || '_';
      (errors[field] ??= []).push(issue.message);
    }
    throw new DomainError(
      'UNPROCESSABLE',
      'VALIDATION_ERROR',
      'The request could not be processed.',
      errors,
    );
  }
}

/** Shorthand: `@Body(zod(schema))`. */
export const zod = <T>(schema: ZodType<T>) => new ZodValidationPipe(schema);
