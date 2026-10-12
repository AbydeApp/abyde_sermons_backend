import type { PipeTransform } from '@nestjs/common';
import { notFound } from '../../domain/domain-error.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route ids are opaque UUIDs; anything else is simply "not found" (no oracle for valid ids). */
export class ParseIdPipe implements PipeTransform<string, string> {
  constructor(private readonly resource = 'Resource') {}

  transform(value: string): string {
    if (!UUID.test(value)) throw notFound(this.resource);
    return value.toLowerCase();
  }
}
