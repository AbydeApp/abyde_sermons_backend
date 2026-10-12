import { z, type ZodType } from 'zod';

const UNSUPPORTED_KEYWORDS = new Set([
  '$schema',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'default',
]);

/**
 * Converts a Zod schema into the subset accepted by OpenAI strict structured outputs:
 * every object closed and fully required. Constraints dropped here are still enforced by Zod
 * when the response is validated.
 */
export function toStrictJsonSchema(schema: ZodType): Record<string, unknown> {
  return strictify(z.toJSONSchema(schema, { io: 'output' })) as Record<
    string,
    unknown
  >;
}

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (node === null || typeof node !== 'object') return node;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    result[key] = strictify(value);
  }
  if (
    result.type === 'object' &&
    typeof result.properties === 'object' &&
    result.properties !== null
  ) {
    result.required = Object.keys(result.properties);
    result.additionalProperties = false;
  }
  return result;
}
