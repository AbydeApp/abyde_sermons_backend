import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AuthContext } from '../../../../shared/application/auth-context.js';
import {CurrentAuth,OptionalAuth,Public,RequiredAuth } from '../../../../shared/infrastructure/http/auth.decorators.js';
import { CREDENTIAL_THROTTLE } from '../../../../shared/infrastructure/http/route-limits.js';
import { RequireIdempotencyKey } from '../../../../shared/infrastructure/http/idempotency.interceptor.js';
import { zod } from '../../../../shared/infrastructure/http/zod-validation.pipe.js';
import type { MeView } from '../../application/me.js';
import { ChangePasswordUseCase,GetMeUseCase,LogoutUseCase,UpdateProfileUseCase } from '../../application/use-cases/account.use-cases.js';
import { LoginUseCase } from '../../application/use-cases/login.use-case.js';
import { ForgotPasswordUseCase, ResetPasswordUseCase } from '../../application/use-cases/password-reset.use-cases.js';
import { RegisterUseCase } from '../../application/use-cases/register.use-case.js';
import { clearSessionCookie, readSessionCookie, SESSION_COOKIE_SETTINGS, type SessionCookieSettings, setSessionCookie } from './session-cookie.js';

const email = z
  .string({ error: 'Email is required' })
  .min(1, 'Email is required')
  .max(254);
const password = z
  .string({ error: 'Password is required' })
  .min(1, 'Password is required')
  .max(256);

const RegisterBody = z.object({
  fullName: z.string({ error: 'Full name is required' }).max(120),
  email,
  password,
});
const LoginBody = z.object({
  email,
  password,
  remember: z.boolean().default(false),
});
const UpdateMeBody = z.object({
  fullName: z.string().max(120).optional(),
  email: email.optional(),
  /** Required only when the email changes. */
  currentPassword: password.optional(),
});
const ChangePasswordBody = z.object({
  currentPassword: password,
  newPassword: password,
});
const ForgotBody = z.object({ email });
const ResetBody = z.object({
  token: z.string().min(1, 'Token is required').max(200),
  password,
});

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(RegisterUseCase) private readonly register: RegisterUseCase,
    @Inject(LoginUseCase) private readonly login: LoginUseCase,
    @Inject(LogoutUseCase) private readonly logout: LogoutUseCase,
    @Inject(GetMeUseCase) private readonly getMe: GetMeUseCase,
    @Inject(UpdateProfileUseCase)
    private readonly updateProfile: UpdateProfileUseCase,
    @Inject(ChangePasswordUseCase)
    private readonly changePassword: ChangePasswordUseCase,
    @Inject(ForgotPasswordUseCase)
    private readonly forgotPassword: ForgotPasswordUseCase,
    @Inject(ResetPasswordUseCase)
    private readonly resetPassword: ResetPasswordUseCase,
    @Inject(SESSION_COOKIE_SETTINGS)
    private readonly cookie: SessionCookieSettings,
  ) {}

  @Public()
  @Throttle(CREDENTIAL_THROTTLE)
  @Post('register')
  @HttpCode(201)
  async registerUser(
    @Body(zod(RegisterBody)) body: z.infer<typeof RegisterBody>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeView> {
    const { me, session } = await this.register.execute({
      ...body,
      userAgent: req.get('user-agent') ?? null,
      ip: req.ip ?? null,
    });
    setSessionCookie(res, this.cookie, session.token, session.expiresAt);
    return me;
  }

  @Public()
  @Throttle(CREDENTIAL_THROTTLE)
  @Post('login')
  @HttpCode(200)
  async loginUser(
    @Body(zod(LoginBody)) body: z.infer<typeof LoginBody>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeView> {
    const { me, session } = await this.login.execute({
      ...body,
      userAgent: req.get('user-agent') ?? null,
      ip: req.ip ?? null,
    });
    setSessionCookie(res, this.cookie, session.token, session.expiresAt);
    return me;
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logoutUser(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.logout.execute(readSessionCookie(req, this.cookie));
    clearSessionCookie(res, this.cookie);
  }

  @OptionalAuth()
  @Get('me')
  me(@CurrentAuth() auth: AuthContext | null): Promise<MeView> {
    return this.getMe.execute(auth);
  }

  @Throttle(CREDENTIAL_THROTTLE)
  @Patch('me')
  updateMe(
    @RequiredAuth() auth: AuthContext,
    @Body(zod(UpdateMeBody)) body: z.infer<typeof UpdateMeBody>,
  ): Promise<MeView> {
    return this.updateProfile.execute(auth, body);
  }

  @Throttle(CREDENTIAL_THROTTLE)
  @Post('change-password')
  @HttpCode(204)
  async changeUserPassword(
    @RequiredAuth() auth: AuthContext,
    @Body(zod(ChangePasswordBody)) body: z.infer<typeof ChangePasswordBody>,
  ): Promise<void> {
    await this.changePassword.execute(auth, body);
  }

  @Public()
  @Throttle(CREDENTIAL_THROTTLE)
  @RequireIdempotencyKey()
  @Post('forgot-password')
  @HttpCode(204)
  async forgot(
    @Body(zod(ForgotBody)) body: z.infer<typeof ForgotBody>,
  ): Promise<void> {
    await this.forgotPassword.execute(body.email);
  }

  @Public()
  @Throttle(CREDENTIAL_THROTTLE)
  @Post('reset-password')
  @HttpCode(204)
  async reset(
    @Body(zod(ResetBody)) body: z.infer<typeof ResetBody>,
  ): Promise<void> {
    await this.resetPassword.execute(body);
  }
}
