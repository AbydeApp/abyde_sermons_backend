import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { APP_CONFIG } from '../../shared/infrastructure/config/config.module.js';
import type { AppConfig } from '../../shared/infrastructure/config/env.schema.js';
import {
  AUTH_SETTINGS,
  type AuthSettings,
} from './application/auth-settings.js';
import {
  ChangePasswordUseCase,
  GetMeUseCase,
  LogoutUseCase,
  UpdateProfileUseCase,
} from './application/use-cases/account.use-cases.js';
import { CompleteOnboardingUseCase } from './application/use-cases/complete-onboarding.use-case.js';
import { LoginUseCase } from './application/use-cases/login.use-case.js';
import {
  ForgotPasswordUseCase,
  ResetPasswordUseCase,
} from './application/use-cases/password-reset.use-cases.js';
import { RegisterUseCase } from './application/use-cases/register.use-case.js';
import { ResolveSessionUseCase } from './application/use-cases/resolve-session.use-case.js';
import { SessionIssuer } from './application/use-cases/session-issuer.js';
import { PASSWORD_HASHER } from './application/ports/out/session-repository.port.js';
import { ScryptPasswordHasher } from './infrastructure/scrypt-password-hasher.js';
import { PurgeExpiredAuthUseCase } from './application/use-cases/purge-expired-auth.use-case.js';
import { AuthJobHandlers } from './presentation/queue/auth-job.handlers.js';
import { AuthController } from './presentation/http/auth.controller.js';
import { SessionAuthGuard } from './presentation/http/session-auth.guard.js';
import {
  SESSION_COOKIE_SETTINGS,
  type SessionCookieSettings,
} from './presentation/http/session-cookie.js';

@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: AUTH_SETTINGS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): AuthSettings => ({
        sessionTtlHours: config.AUTH_SESSION_TTL_HOURS,
        rememberTtlDays: config.AUTH_REMEMBER_TTL_DAYS,
        resetTokenTtlMinutes: config.AUTH_RESET_TOKEN_TTL_MINUTES,
        webUrl: config.APP_WEB_URL,
      }),
    },
    {
      provide: SESSION_COOKIE_SETTINGS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): SessionCookieSettings => ({
        name: config.AUTH_COOKIE_NAME,
        domain: config.AUTH_COOKIE_DOMAIN,
        secure: config.cookieSecure,
      }),
    },
    { provide: PASSWORD_HASHER, useClass: ScryptPasswordHasher },
    SessionIssuer,
    RegisterUseCase,
    LoginUseCase,
    LogoutUseCase,
    GetMeUseCase,
    UpdateProfileUseCase,
    ChangePasswordUseCase,
    ForgotPasswordUseCase,
    ResetPasswordUseCase,
    ResolveSessionUseCase,
    CompleteOnboardingUseCase,
    PurgeExpiredAuthUseCase,
    AuthJobHandlers,
    { provide: APP_GUARD, useClass: SessionAuthGuard },
  ],
  exports: [GetMeUseCase, CompleteOnboardingUseCase, ResolveSessionUseCase],
})
export class AuthModule {}
