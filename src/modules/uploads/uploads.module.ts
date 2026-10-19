import { Module } from '@nestjs/common';
import { UploadsController } from './uploads.controller.js';
import { UploadsService } from './uploads.service.js';

/** UPLOAD_REPOSITORY and storage are bound by the composition root. */
@Module({
  controllers: [UploadsController],
  providers: [UploadsService],
  exports: [UploadsService],
})
export class UploadsModule {}
