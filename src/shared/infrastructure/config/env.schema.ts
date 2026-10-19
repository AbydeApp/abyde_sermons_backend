import { z } from 'zod';

/** Public development default; rejected in staging and production. */
export const DEV_ACCESS_TOKEN_SECRET = 'dev-only-access-token-secret-change-me-in-real-envs';

const booleanString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');
const optionalString = z
  .string()
  .optional()
  .transform((value) =>
    value === undefined || value.trim() === '' ? undefined : value,
  );
const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    );

const SOCIAL_CREDENTIAL_PAIRS = [
  ['SOCIAL_META_APP_ID', 'SOCIAL_META_APP_SECRET'],
  ['SOCIAL_TIKTOK_CLIENT_KEY', 'SOCIAL_TIKTOK_CLIENT_SECRET'],
  ['SOCIAL_GOOGLE_CLIENT_ID', 'SOCIAL_GOOGLE_CLIENT_SECRET'],
  ['SOCIAL_X_CLIENT_ID', 'SOCIAL_X_CLIENT_SECRET'],
  ['SOCIAL_LINKEDIN_CLIENT_ID', 'SOCIAL_LINKEDIN_CLIENT_SECRET'],
] as const;

export const envSchema = z
  .object({
    // APP_*
    APP_ENV: z
      .enum(['development', 'test', 'staging', 'production'])
      .default('development'),
    APP_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    APP_CORS_ORIGINS: csv('http://localhost:3001'),
    APP_WEB_URL: z.string().url().default('http://localhost:3001'),
    APP_PUBLIC_API_URL: z
      .string()
      .url()
      .default('http://localhost:4000/api/v1'),
    APP_SWAGGER_ENABLED: booleanString.optional(),
    APP_LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    APP_RATE_LIMIT_TTL_MS: z.coerce.number().int().positive().default(60_000),
    APP_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    APP_TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),

    // DATABASE_* / REDIS_*
    DATABASE_URL: z.string().url(),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
    // Peak number of processes holding a pool (API + workers + migration job, doubled during a deploy).
    DATABASE_EXPECTED_PROCESSES: z.coerce.number().int().positive().optional(),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(15_000),
    APP_SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).default(5_000),
    REDIS_URL: z.string().url(),

    // AUTH_*
    // HMAC secret that signs access tokens; production/staging must set their own.
    AUTH_ACCESS_TOKEN_SECRET: z.string().min(32).default(DEV_ACCESS_TOKEN_SECRET),
    AUTH_ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
    AUTH_SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24),
    AUTH_REMEMBER_TTL_DAYS: z.coerce.number().int().positive().default(30),
    AUTH_RESET_TOKEN_TTL_MINUTES: z.coerce
      .number()
      .int()
      .positive()
      .default(60),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10), // per IP per minute on credential endpoints
    APP_AI_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20), // per IP per minute on AI-backed endpoints

    // STORAGE_*
    STORAGE_PROVIDER: z.enum(['s3']).default('s3'),
    STORAGE_ENDPOINT: optionalString,
    STORAGE_REGION: z.string().default('auto'),
    STORAGE_BUCKET: z.string().default('abyde-sermon-dev'),
    STORAGE_ACCESS_KEY_ID: optionalString,
    STORAGE_SECRET_ACCESS_KEY: optionalString,
    STORAGE_FORCE_PATH_STYLE: booleanString.default(false),
    // Optional public delivery host (CDN / public bucket domain) for generated media only.
    STORAGE_PUBLIC_BASE_URL: optionalString.pipe(z.string().url().optional()),

    // AI_* / TRANSCRIPTION_*
    AI_PROVIDER: z.enum(['openai', 'fake']).default('fake'),
    AI_OPENAI_API_KEY: optionalString,
    AI_OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
    AI_TEXT_MODEL: z.string().default('gpt-4.1-mini'),
    AI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
    AI_TEXT_INPUT_COST_PER_MTOK: z.coerce.number().min(0).default(0.4),
    AI_TEXT_OUTPUT_COST_PER_MTOK: z.coerce.number().min(0).default(1.6),
    AI_EMBEDDING_COST_PER_MTOK: z.coerce.number().min(0).default(0.02),
    TRANSCRIPTION_PROVIDER: z.enum(['openai', 'fake']).default('fake'),
    TRANSCRIPTION_MODEL: z.string().default('whisper-1'),
    TRANSCRIPTION_COST_PER_MINUTE: z.coerce.number().min(0).default(0.006),
    TRANSCRIPTION_FFMPEG_PATH: z.string().default('ffmpeg'),
    TRANSCRIPTION_FFPROBE_PATH: z.string().default('ffprobe'),

    // WORKER_*
    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
    // How long running jobs may finish after SIGTERM. Must cover the longest job time limit and
    // be no longer than the platform's termination grace period.
    WORKER_SHUTDOWN_GRACE_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(30 * 60_000),
    WORKER_TMP_DIR: optionalString,

    // BILLING_*
    BILLING_PROVIDER: z.enum(['paystack', 'fake']).default('fake'),
    BILLING_PAYSTACK_SECRET_KEY: optionalString,
    BILLING_PAYSTACK_PLAN_STANDARD: optionalString,

    // EMAIL_*
    EMAIL_PROVIDER: z.enum(['resend', 'outbox']).default('outbox'),
    EMAIL_RESEND_API_KEY: optionalString,
    EMAIL_FROM: z.string().default('Abyde Sermon <no-reply@abyde.app>'),
    EMAIL_OUTBOX_DIR: z.string().default('.outbox'),

    // PUBLISHING_* (integrations)
    PUBLISHING_ENCRYPTION_KEY: optionalString, // base64-encoded 32 bytes
    PUBLISHING_META_APP_ID: optionalString,
    PUBLISHING_META_APP_SECRET: optionalString,
    PUBLISHING_META_GRAPH_VERSION: z.string().default('v21.0'),
    PUBLISHING_MAILCHIMP_CLIENT_ID: optionalString,
    PUBLISHING_MAILCHIMP_CLIENT_SECRET: optionalString,

    // SOCIAL_* (direct social publishing: Meta, TikTok, YouTube, X, LinkedIn)
    SOCIAL_TOKEN_ENCRYPTION_KEY: optionalString, // base64-encoded 32 bytes
    // Comma-separated retired keys, still accepted for decryption during a key rotation.
    SOCIAL_TOKEN_ENCRYPTION_KEYS_PREVIOUS: csv(''),
    // How long a provider may fetch media it was handed (signed URL lifetime).
    SOCIAL_MEDIA_URL_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(300)
      .max(7 * 24 * 3600)
      .default(6 * 3600),
    SOCIAL_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    SOCIAL_META_APP_ID: optionalString,
    SOCIAL_META_APP_SECRET: optionalString,
    SOCIAL_META_GRAPH_VERSION: z.string().default('v21.0'),
    SOCIAL_TIKTOK_CLIENT_KEY: optionalString,
    SOCIAL_TIKTOK_CLIENT_SECRET: optionalString,
    // Until TikTok approves the app (audit), every post it makes is private (SELF_ONLY).
    SOCIAL_TIKTOK_AUDITED: booleanString.default(false),
    SOCIAL_GOOGLE_CLIENT_ID: optionalString,
    SOCIAL_GOOGLE_CLIENT_SECRET: optionalString,
    SOCIAL_X_CLIENT_ID: optionalString,
    SOCIAL_X_CLIENT_SECRET: optionalString,
    SOCIAL_LINKEDIN_CLIENT_ID: optionalString,
    SOCIAL_LINKEDIN_CLIENT_SECRET: optionalString,
    SOCIAL_LINKEDIN_API_VERSION: z
      .string()
      .regex(/^\d{6}$/, 'must be YYYYMM')
      .default('202609'),
    // Organization (Page) posting needs LinkedIn's Community Management API approval.
    SOCIAL_LINKEDIN_ORGANIZATIONS: booleanString.default(false),

    // MEDIA_* (branded image / video rendering in the worker)
    MEDIA_FFMPEG_PATH: z.string().default('ffmpeg'),
    MEDIA_FFPROBE_PATH: z.string().default('ffprobe'),
    MEDIA_MAX_CLIP_SECONDS: z.coerce
      .number()
      .int()
      .min(5)
      .max(600)
      .default(180),

    // OBSERVABILITY_*
    OBSERVABILITY_METRICS_TOKEN: optionalString,
    OBSERVABILITY_SENTRY_DSN: optionalString,
    OBSERVABILITY_TRACES_SAMPLE_RATE: z.coerce
      .number()
      .min(0)
      .max(1)
      .default(0),
  })
  .superRefine((env, ctx) => {
    const require = (condition: boolean, path: string, message: string) => {
      if (condition) ctx.addIssue({ code: 'custom', path: [path], message });
    };
    require(env.AI_PROVIDER === 'openai' &&
      !env.AI_OPENAI_API_KEY, 'AI_OPENAI_API_KEY', 'required when AI_PROVIDER=openai');
    require(env.TRANSCRIPTION_PROVIDER === 'openai' &&
      !env.AI_OPENAI_API_KEY, 'AI_OPENAI_API_KEY', 'required when TRANSCRIPTION_PROVIDER=openai');
    require(env.BILLING_PROVIDER === 'paystack' &&
      !env.BILLING_PAYSTACK_SECRET_KEY, 'BILLING_PAYSTACK_SECRET_KEY', 'required when BILLING_PROVIDER=paystack');
    require(env.EMAIL_PROVIDER === 'resend' &&
      !env.EMAIL_RESEND_API_KEY, 'EMAIL_RESEND_API_KEY', 'required when EMAIL_PROVIDER=resend');
    require(env.STORAGE_PROVIDER === 's3' &&
      (!env.STORAGE_ACCESS_KEY_ID ||
        !env.STORAGE_SECRET_ACCESS_KEY), 'STORAGE_ACCESS_KEY_ID', 'STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY are required when STORAGE_PROVIDER=s3');
    if (
      env.PUBLISHING_ENCRYPTION_KEY &&
      Buffer.from(env.PUBLISHING_ENCRYPTION_KEY, 'base64').length !== 32
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLISHING_ENCRYPTION_KEY'],
        message: 'must be 32 bytes, base64-encoded',
      });
    }
    if (
      [
        env.SOCIAL_TOKEN_ENCRYPTION_KEY,
        ...env.SOCIAL_TOKEN_ENCRYPTION_KEYS_PREVIOUS,
      ].some(
        (key) => key !== undefined && Buffer.from(key, 'base64').length !== 32,
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['SOCIAL_TOKEN_ENCRYPTION_KEY'],
        message: 'must be 32 bytes, base64-encoded',
      });
    }
    // A provider is either fully configured or not at all.
    for (const [id, secret] of SOCIAL_CREDENTIAL_PAIRS) {
      require(Boolean(env[id]) !==
        Boolean(
          env[secret],
        ), secret, `${id} and ${secret} must be set together`);
    }
    if (env.APP_ENV === 'production') {
      // The API documentation is never served (unauthenticated) in production.
      require(env.APP_SWAGGER_ENABLED ===
        true, 'APP_SWAGGER_ENABLED', 'must not be true in production');
      // Fakes and in-memory adapters must never serve real churches.
      for (const [key, fake] of [
        ['AI_PROVIDER', 'fake'],
        ['TRANSCRIPTION_PROVIDER', 'fake'],
        ['BILLING_PROVIDER', 'fake'],
        ['EMAIL_PROVIDER', 'outbox'],
      ] as const) {
        require(env[key] === fake, key, `${fake} is not allowed in production`);
      }
    }
    if (env.APP_ENV === 'production' || env.APP_ENV === 'staging') {
      // Internet-reachable environments: no localhost/plain-http URLs, no development
      // access-token secret, no publicly known fake-billing secret, and a real metrics token.
      const publicUrls: Array<[string, string]> = [
        ['APP_WEB_URL', env.APP_WEB_URL],
        ['APP_PUBLIC_API_URL', env.APP_PUBLIC_API_URL],
        ...env.APP_CORS_ORIGINS.map((origin): [string, string] => [
          'APP_CORS_ORIGINS',
          origin,
        ]),
      ];
      for (const [key, value] of publicUrls) {
        require(!value.startsWith('https://') ||
          /^https:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(
            value,
          ), key, `must be a public https URL in ${env.APP_ENV}`);
      }
      require(env.DATABASE_EXPECTED_PROCESSES ===
        undefined, 'DATABASE_EXPECTED_PROCESSES', `is required in ${env.APP_ENV} (peak process count, for the connection budget check)`);
      require(env.AUTH_ACCESS_TOKEN_SECRET ===
        DEV_ACCESS_TOKEN_SECRET, 'AUTH_ACCESS_TOKEN_SECRET', `must be set explicitly in ${env.APP_ENV}`);
      require(env.BILLING_PROVIDER ===
        'fake', 'BILLING_PROVIDER', `fake is not allowed in ${env.APP_ENV} (use Paystack test keys)`);
      require(env.OBSERVABILITY_METRICS_TOKEN !== undefined &&
        env.OBSERVABILITY_METRICS_TOKEN.length <
          24, 'OBSERVABILITY_METRICS_TOKEN', 'must be at least 24 characters');
      require(env.BILLING_PROVIDER === 'paystack' &&
        !(
          env.BILLING_PAYSTACK_PLAN_STANDARD
        ), 'BILLING_PAYSTACK_PLAN_STANDARD', 'BILLING_PAYSTACK_PLAN_STANDARD is required with Paystack');
      // Deployed environments hold real integration tokens: never fall back to the development key.
      require(!env.PUBLISHING_ENCRYPTION_KEY, 'PUBLISHING_ENCRYPTION_KEY', 'required in staging and production');
      // Social tokens get their own key; it is mandatory as soon as any provider can connect.
      require(socialProvidersConfigured(env) &&
        !env.SOCIAL_TOKEN_ENCRYPTION_KEY, 'SOCIAL_TOKEN_ENCRYPTION_KEY', `required in ${env.APP_ENV} when a SOCIAL_* provider is configured`);
      require(env.STORAGE_PUBLIC_BASE_URL !== undefined &&
        !env.STORAGE_PUBLIC_BASE_URL.startsWith(
          'https://',
        ), 'STORAGE_PUBLIC_BASE_URL', `must be https in ${env.APP_ENV}`);
    }
  });

export type Env = z.infer<typeof envSchema>;

/** True when at least one direct social provider has credentials. */
export function socialProvidersConfigured(
  env: Record<(typeof SOCIAL_CREDENTIAL_PAIRS)[number][0], string | undefined>,
): boolean {
  return SOCIAL_CREDENTIAL_PAIRS.some(([id]) => Boolean(env[id]));
}

export type AppConfig = Env & {
  swaggerEnabled: boolean;
};

/** Adds the settings derived from validated environment values. */
export function withDerivedSettings(env: Env): AppConfig {
  return {
    ...env,
    // Swagger is on outside production unless explicitly overridden (never on in production).
    swaggerEnabled: env.APP_SWAGGER_ENABLED ?? env.APP_ENV !== 'production',
  };
}

/** Validates a raw environment directly (used by schema unit tests; the app goes through ConfigModule). */
export function parseEnv(raw: Record<string, string | undefined>): AppConfig {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return withDerivedSettings(result.data);
}
