import { Module } from '@nestjs/common';
import {
  ConsumeUploadUseCase,
  PresignUploadUseCase,
  PurgeStaleUploadsUseCase,
} from './application/use-cases/upload.use-cases.js';
import { UploadsController } from './presentation/http/uploads.controller.js';

/** Repository/storage adapters are bound by the infrastructure composition root. */
@Module({
  controllers: [UploadsController],
  providers: [
    PresignUploadUseCase,
    ConsumeUploadUseCase,
    PurgeStaleUploadsUseCase,
  ],
  exports: [
    PresignUploadUseCase,
    ConsumeUploadUseCase,
    PurgeStaleUploadsUseCase,
  ],
})
export class UploadsModule {}
