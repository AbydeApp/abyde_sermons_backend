import * as Sentry from '@sentry/node';

let enabled = false;

/** Attribute names that may carry request bodies, credentials or query strings. */
const SENSITIVE_ATTRIBUTE = /(body|cookie|authorization|query|set-cookie)/i;

type AttributeValue = unknown;

/** Removes sensitive attributes and strips query strings from URL-like values. */
export function scrubAttributes(
  attributes: Record<string, AttributeValue> | undefined,
): void {
  if (!attributes) return;
  for (const key of Object.keys(attributes)) {
    if (SENSITIVE_ATTRIBUTE.test(key)) {
      delete attributes[key];
      continue;
    }
    const entry = attributes[key];
    // Streamed spans wrap values as { value, type }; static spans use the raw value.
    const holder =
      typeof entry === 'object' && entry !== null && 'value' in entry
        ? (entry as { value: unknown })
        : null;
    const value = holder ? holder.value : entry;
    if (
      typeof value === 'string' &&
      /url|target|path/i.test(key) &&
      value.includes('?')
    ) {
      const stripped = value.slice(0, value.indexOf('?'));
      if (holder) holder.value = stripped;
      else attributes[key] = stripped;
    }
  }
}

/**
 * Error monitoring and tracing (Sentry), initialised only when a DSN is configured.
 * Request bodies, cookies, auth headers and query strings are never sent: body capture is switched
 * off at the source, and events and spans are scrubbed again before they leave the process.
 */
export function initErrorReporting(
  dsn: string | undefined,
  environment: string,
  release?: string,
  tracesSampleRate = 0,
): void {
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment,
    release,
    // Traces show which handler, query or outbound call took the time.
    tracesSampleRate,
    // Never attach incoming request bodies (they contain passwords and sermon text).
    integrations: [
      Sentry.httpServerIntegration({ maxRequestBodySize: 'none' }),
    ],
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.query_string;
        if (event.request.url)
          event.request.url = event.request.url.split('?')[0];
        if (event.request.headers) {
          delete event.request.headers.cookie;
          delete event.request.headers.authorization;
        }
      }
      return event;
    },
    beforeSendSpan(span) {
      scrubAttributes(
        span.attributes as Record<string, AttributeValue> | undefined,
      );
      if (typeof span.name === 'string' && span.name.includes('?'))
        span.name = span.name.split('?')[0] ?? span.name;
      return span;
    },
  });
  enabled = true;
}

export function reportError(
  error: unknown,
  context: Record<string, unknown> = {},
): void {
  if (enabled) Sentry.captureException(error, { extra: context });
}
