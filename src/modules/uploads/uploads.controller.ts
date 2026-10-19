import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { CurrentChurchId } from '../../shared/infrastructure/http/auth.decorators.js';
import { zod } from '../../shared/infrastructure/http/zod-validation.pipe.js';
import { type PresignedUploadResponse, SermonPresignBody, toPresignedUploadResponse } from './helper.js';
import { UploadsService } from './uploads.service.js';

@ApiTags('uploads')
@Controller('uploads')
export class UploadsController {
  constructor(@Inject(UploadsService) private readonly uploads: UploadsService) {}

  @Post('presign')
  @HttpCode(200)
  async presign(
    @CurrentChurchId() churchId: string,
    @Body(zod(SermonPresignBody)) body: z.infer<typeof SermonPresignBody>,
  ): Promise<PresignedUploadResponse> {
    return toPresignedUploadResponse(await this.uploads.presign({ churchId, ...body }));
  }
}
