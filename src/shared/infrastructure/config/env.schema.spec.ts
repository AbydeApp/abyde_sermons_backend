import { parseEnv } from './env.schema.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  STORAGE_ACCESS_KEY_ID: 'key',
  STORAGE_SECRET_ACCESS_KEY: 'secret',
};

const production = {
  ...base,
  APP_ENV: 'production',
  AI_PROVIDER: 'openai',
  TRANSCRIPTION_PROVIDER: 'openai',
  AI_OPENAI_API_KEY: 'sk-test',
  BILLING_PROVIDER: 'paystack',
  BILLING_PAYSTACK_SECRET_KEY: 'sk_test',
  EMAIL_PROVIDER: 'resend',
  EMAIL_RESEND_API_KEY: 're_test',
  PUBLISHING_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  BILLING_PAYSTACK_PLAN_STANDARD: 'PLN_g',
  DATABASE_EXPECTED_PROCESSES: '11',
  AUTH_ACCESS_TOKEN_SECRET: 'x'.repeat(48),
  APP_WEB_URL: 'https://app.abyde.app',
  APP_PUBLIC_API_URL: 'https://api.abyde.app/api/v1',
  APP_CORS_ORIGINS: 'https://app.abyde.app',
};

describe('parseEnv', () => {
  it('applies defaults and splits the CORS allowlist', () => {
    const config = parseEnv({
      ...base,
      APP_CORS_ORIGINS: 'https://a.com, https://b.com',
    });
    expect(config.APP_PORT).toBe(4000);
    expect(config.APP_CORS_ORIGINS).toEqual(['https://a.com', 'https://b.com']);
  });

  it('enables swagger outside production and disables it in production by default', () => {
    expect(parseEnv({ ...production, APP_ENV: 'staging' }).swaggerEnabled).toBe(
      true,
    );
    expect(parseEnv(production).swaggerEnabled).toBe(false);
    expect(() =>
      parseEnv({ ...production, APP_SWAGGER_ENABLED: 'true' }),
    ).toThrow(/APP_SWAGGER_ENABLED/);
  });

  it('fails fast on missing or malformed variables', () => {
    expect(() => parseEnv({ REDIS_URL: base.REDIS_URL })).toThrow(
      /DATABASE_URL/,
    );
    expect(() => parseEnv({ ...base, APP_PORT: 'abc' })).toThrow(/APP_PORT/);
    expect(() => parseEnv({ ...base, AI_PROVIDER: 'openai' })).toThrow(
      /AI_OPENAI_API_KEY/,
    );
    expect(() =>
      parseEnv({ ...base, PUBLISHING_ENCRYPTION_KEY: 'c2hvcnQ=' }),
    ).toThrow(/32 bytes/);
  });

  it('refuses fake adapters and missing secrets in production', () => {
    expect(() => parseEnv({ ...production, AI_PROVIDER: 'fake' })).toThrow(
      /AI_PROVIDER/,
    );
    expect(() =>
      parseEnv({ ...production, PUBLISHING_ENCRYPTION_KEY: undefined }),
    ).toThrow(/PUBLISHING_ENCRYPTION_KEY/);
  });

  it('rejects unsafe settings in staging and production', () => {
    for (const APP_ENV of ['staging', 'production']) {
      const env = { ...production, APP_ENV };
      expect(() =>
        parseEnv({ ...env, APP_WEB_URL: 'http://localhost:3001' }),
      ).toThrow(/APP_WEB_URL/);
      expect(() =>
        parseEnv({
          ...env,
          APP_CORS_ORIGINS: 'https://app.abyde.app,http://localhost:3001',
        }),
      ).toThrow(/APP_CORS_ORIGINS/);
      expect(() => parseEnv({ ...env, BILLING_PROVIDER: 'fake' })).toThrow(
        /BILLING_PROVIDER/,
      );
      expect(() =>
        parseEnv({ ...env, PUBLISHING_ENCRYPTION_KEY: undefined }),
      ).toThrow(/PUBLISHING_ENCRYPTION_KEY/);
      expect(() =>
        parseEnv({ ...env, OBSERVABILITY_METRICS_TOKEN: 'short' }),
      ).toThrow(/OBSERVABILITY_METRICS_TOKEN/);
      expect(() =>
        parseEnv({ ...env, DATABASE_EXPECTED_PROCESSES: undefined }),
      ).toThrow(/DATABASE_EXPECTED_PROCESSES/);
      expect(() =>
        parseEnv({ ...env, BILLING_PAYSTACK_PLAN_STANDARD: undefined }),
      ).toThrow(/BILLING_PAYSTACK_PLAN/);
    }
  });
});
