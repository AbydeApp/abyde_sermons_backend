import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentChurchId } from '../../../../shared/infrastructure/http/auth.decorators.js';
import { zod } from '../../../../shared/infrastructure/http/zod-validation.pipe.js';
import { PresignUploadUseCase } from '../../application/use-cases/upload.use-cases.js';
import {
  type PresignedUploadResponse,
  toPresignedUploadResponse,
} from './presigned-upload.response.js';

export const PresignBody = z.object({
  fileName: z
    .string({ error: 'File name is required' })
    .min(1, 'File name is required')
    .max(255),
  contentType: z.string({ error: 'Content type is required' }).min(1).max(255),
  sizeBytes: z.number({ error: 'File size is required' }).int().positive(),
});

const SermonPresignBody = PresignBody.extend({
  purpose: z.literal('SERMON_MEDIA'),
});

@ApiTags('uploads')
@Controller('uploads')
export class UploadsController {
  constructor(
    @Inject(PresignUploadUseCase)
    private readonly presign: PresignUploadUseCase,
  ) {}

  @Post('presign')
  @HttpCode(200)
  async presignUpload(
    @CurrentChurchId() churchId: string,
    @Body(zod(SermonPresignBody)) body: z.infer<typeof SermonPresignBody>,
  ): Promise<PresignedUploadResponse> {
    return toPresignedUploadResponse(
      await this.presign.execute({ churchId, ...body }),
    );
  }
}
