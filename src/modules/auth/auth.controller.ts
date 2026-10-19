import { Body, Controller, Get, HttpCode, Inject, Patch, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { z } from 'zod';
import type { AuthContext } from '../../shared/application/auth-context.js';
import { CurrentAuth, CurrentChurchId, OptionalAuth, Public, RequiredAuth } from '../../shared/infrastructure/http/auth.decorators.js';
import { RequireIdempotencyKey } from '../../shared/infrastructure/http/idempotency.interceptor.js';
import { CREDENTIAL_THROTTLE } from '../../shared/infrastructure/http/route-limits.js';
import { zod } from '../../shared/infrastructure/http/zod-validation.pipe.js';
import type { ChurchView } from '../../shared/application/auth-context.js';
import { AuthService } from './auth.service.js';
import {
  type AuthTokens, ChangePasswordBody, ForgotBody, LoginBody, LogoutBody, type MeView, RefreshBody, RegisterBody,
  ResendBody, ResetBody, UpdateChurchBody, UpdateMeBody, VerifyEmailBody,
} from './helper.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Throttle(CREDENTIAL_THROTTLE)
  @Post('register')
  @HttpCode(201)
  register(@Body(zod(RegisterBody)) body: z.infer<typeof RegisterBody>): Promise<{ email: string }> {
    return this.auth.register(body);
  }

  @Public()
  @Throttle(CREDENTIAL_THROTTLE)
  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(
    @Body(zod(VerifyEmailBody)) body: z.infer<typeof VerifyEmailBody>,
    @Req() req: Request,
  ): Promise<MeView & AuthTokens> {
    const { me, tokens } = await this.auth.verifyEmail({ ...body, userAgent: req.get('user-agent') ?? null });
    return { ...me, ...tokens };
  }

  @Public()
  @Throttle(CREDENTIAL_THROTTLE)
  @Post('resend-verification')
  @HttpCode(204)
  async resendVerification(@Body(zod(ResendBody)) body: z.infer<typeof ResendBody>): Promise<void> {
    await this.auth.resendVerification(body.email);
  }

  @Public()
  @Throttle(CREDENTIAL_THROTTLE)
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(zod(LoginBody)) body: z.infer<typeof LoginBody>,
    @Req() req: Request,
  ): Promise<MeView & AuthTokens> {
    const { me, tokens } = await this.auth.login({ ...body, userAgent: req.get('user-agent') ?? null });
    return { ...me, ...tokens };
  }

  @Public()
  @Throttle(CREDENTIAL_THROTTLE)
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body(zod(RefreshBody)) body: z.infer<typeof RefreshBody>): Promise<AuthTokens> {
    return this.auth.refresh(body.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body(zod(LogoutBody)) body: z.infer<typeof LogoutBody>): Promise<void> {
    await this.auth.logout(body.refreshToken);
  }

  @OptionalAuth()
  @Get('me')
  me(@CurrentAuth() auth: AuthContext | null): Promise<MeView> {
    return this.auth.getMe(auth);
  }

  @Throttle(CREDENTIAL_THROTTLE)
  @Patch('me')
  updateMe(
    @RequiredAuth() auth: AuthContext,
    @Body(zod(UpdateMeBody)) body: z.infer<typeof UpdateMeBody>,
  ): Promise<MeView> {
    return this.auth.updateProfile(auth, body);
  }

  @Throttle(CREDENTIAL_THROTTLE)
  @Post('change-password')
  @HttpCode(204)
  async changePassword(
    @RequiredAuth() auth: AuthContext,
    @Body(zod(ChangePasswordBody)) body: z.infer<typeof ChangePasswordBody>,
  ): Promise<void> {
    await this.auth.changePassword(auth, body);
  }

  @Public()
  @Throttle(CREDENTIAL_THROTTLE)
  @RequireIdempotencyKey()
  @Post('forgot-password')
  @HttpCode(204)
  async forgotPassword(@Body(zod(ForgotBody)) body: z.infer<typeof ForgotBody>): Promise<void> {
    await this.auth.requestPasswordReset(body.email);
  }

  @Public()
  @Throttle(CREDENTIAL_THROTTLE)
  @Post('reset-password')
  @HttpCode(204)
  async resetPassword(@Body(zod(ResetBody)) body: z.infer<typeof ResetBody>): Promise<void> {
    await this.auth.resetPassword(body);
  }
}

/** The signed-in user's church profile (it is created at signup). */
@ApiTags('church')
@Controller('church')
export class ChurchController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get()
  get(@CurrentChurchId() churchId: string): Promise<ChurchView> {
    return this.auth.getChurch(churchId);
  }

  @Patch()
  update(
    @CurrentChurchId() churchId: string,
    @Body(zod(UpdateChurchBody)) body: z.infer<typeof UpdateChurchBody>,
  ): Promise<ChurchView> {
    return this.auth.updateChurch(churchId, body);
  }
}
