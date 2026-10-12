import { Global, Module } from '@nestjs/common';
import { CHURCH_DIRECTORY } from '../../shared/application/auth-context.js';
import { CHURCH_PROFILE } from '../../shared/application/church-profile.js';
import { AuthModule } from '../auth/auth.module.js';
import { UploadsModule } from '../uploads/uploads.module.js';
import { ChurchPresenter } from './application/church-presenter.js';
import {
  ChurchDirectory,
  ChurchProfileService,
  CreateChurchUseCase,
  GetChurchUseCase,
  PresignLogoUseCase,
  UpdateChurchUseCase,
} from './application/use-cases/church.use-cases.js';
import { ChurchController } from './presentation/http/church.controller.js';

/** Global so other modules read church profiles through CHURCH_DIRECTORY / CHURCH_PROFILE without import cycles. */
@Global()
@Module({
  imports: [AuthModule, UploadsModule],
  controllers: [ChurchController],
  providers: [
    ChurchPresenter,
    CreateChurchUseCase,
    GetChurchUseCase,
    UpdateChurchUseCase,
    PresignLogoUseCase,
    { provide: CHURCH_DIRECTORY, useClass: ChurchDirectory },
    { provide: CHURCH_PROFILE, useClass: ChurchProfileService },
  ],
  exports: [CHURCH_DIRECTORY, CHURCH_PROFILE, GetChurchUseCase],
})
export class ChurchModule {}
