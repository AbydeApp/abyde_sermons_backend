import { type DynamicModule, Global, Module } from '@nestjs/common';
import {
  ConfigModule as NestConfigModule,
  ConfigService,
} from '@nestjs/config';
import {
  type AppConfig,
  type Env,
  envSchema,
  withDerivedSettings,
} from './env.schema.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

/** Keys whose schema allows `undefined`; every other key is required after validation. */
const OPTIONAL_KEYS = new Set(
  Object.entries(envSchema.shape)
    .filter(
      ([, schema]) =>
        schema.safeParse(undefined).success &&
        schema.safeParse(undefined).data === undefined,
    )
    .map(([key]) => key),
);

/**
 * Builds the typed settings object the adapters receive. Required values are read with
 * `getOrThrow`, so a value that is somehow missing fails loudly instead of becoming `undefined`.
 */
export function loadAppConfig(config: ConfigService<Env, true>): AppConfig {
  const entries = (Object.keys(envSchema.shape) as Array<keyof Env>).map(
    (key) => [
      key,
      OPTIONAL_KEYS.has(key)
        ? config.get(key, { infer: true })
        : config.getOrThrow(key, { infer: true }),
    ],
  );
  return withDerivedSettings(Object.fromEntries(entries) as Env);
}

/**
 * Every environment variable is validated against the Zod schema when the module loads: a missing
 * or malformed value stops the process before it takes traffic. Nothing here logs values.
 */
@Global()
@Module({})
export class ConfigModule {
  /**
   * Built when the application module is assembled (not at import time), so the environment is
   * read and validated at boot.
   */
  static register(): DynamicModule {
    return {
      module: ConfigModule,
      imports: [
        NestConfigModule.forRoot({
          validationSchema: envSchema,
          // Deployed environments get variables from the platform; tests set them explicitly.
          ignoreEnvFile:
            process.env.NODE_ENV === 'production' ||
            process.env.APP_ENV === 'test',
        }),
      ],
      providers: [
        {
          provide: APP_CONFIG,
          inject: [ConfigService],
          useFactory: loadAppConfig,
        },
      ],
      exports: [APP_CONFIG],
    };
  }
}
