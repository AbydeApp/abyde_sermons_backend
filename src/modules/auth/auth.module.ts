import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ACCESS_TOKEN_SIGNER } from './adapters/access-token-signer.js';
import { HmacAccessTokenSigner } from './adapters/hmac-access-token-signer.js';
import { CHURCH_DIRECTORY } from '../../shared/application/auth-context.js';
import { CHURCH_PROFILE } from '../../shared/application/church-profile.js';
import { PASSWORD_HASHER } from './adapters/password-hasher.js';
import { ScryptPasswordHasher } from './adapters/scrypt-password-hasher.js';
import { AuthController, ChurchController } from './auth.controller.js';
import { AccessTokenGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';

/**
 * Global so other modules read the church through CHURCH_DIRECTORY / CHURCH_PROFILE without import
 * cycles. AUTH_REPOSITORY is bound to its adapter in src/composition/.
 */
@Global()
@Module({
  controllers: [AuthController, ChurchController],
  providers: [
    { provide: PASSWORD_HASHER, useClass: ScryptPasswordHasher },
    { provide: ACCESS_TOKEN_SIGNER, useClass: HmacAccessTokenSigner },
    AuthService,
    { provide: CHURCH_DIRECTORY, useExisting: AuthService },
    { provide: CHURCH_PROFILE, useExisting: AuthService },
    { provide: APP_GUARD, useClass: AccessTokenGuard },
  ],
  exports: [AuthService, CHURCH_DIRECTORY, CHURCH_PROFILE],
})
export class AuthModule {}
