import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type {
  AuthContext,
  ChurchView,
} from '../../../../shared/application/auth-context.js';
import {
  CurrentChurchId,
  RequiredAuth,
} from '../../../../shared/infrastructure/http/auth.decorators.js';
import { zod } from '../../../../shared/infrastructure/http/zod-validation.pipe.js';
import type { MeView } from '../../../auth/application/me.js';
import { PresignBody } from '../../../uploads/presentation/http/uploads.controller.js';
import {
  type PresignedUploadResponse,
  toPresignedUploadResponse,
} from '../../../uploads/presentation/http/presigned-upload.response.js';
import {
  CreateChurchUseCase,
  GetChurchUseCase,
  PresignLogoUseCase,
  UpdateChurchUseCase,
} from '../../application/use-cases/church.use-cases.js';

const text = (max: number) =>
  z.string().max(max, `Must be at most ${max} characters`);
const nullableText = (max: number) => text(max).nullable();

const CreateChurchBody = z.object({
  name: z
    .string({ error: 'Church name is required' })
    .min(1, 'Church name is required')
    .max(120),
  ownerRole: z
    .string({ error: 'Your role is required' })
    .min(1, 'Your role is required')
    .max(80),
  denomination: nullableText(120).optional(),
  website: nullableText(255).optional(),
});

const UpdateChurchBody = z
  .object({
    name: text(120),
    ownerRole: text(80),
    denomination: nullableText(120),
    website: nullableText(255),
    description: nullableText(2000),
    preferredBibleTranslation: text(20),
    primaryColor: nullableText(7),
    secondaryColor: nullableText(7),
    devotionalTone: nullableText(200),
    socialTone: nullableText(200),
    audienceDescription: text(1000),
    wordsToAvoid: text(1000),
    additionalAIContext: text(2000),
    logoObjectKey: text(512),
  })
  .partial()
  .strict();

@ApiTags('church')
@Controller('church')
export class ChurchController {
  constructor(
    @Inject(CreateChurchUseCase)
    private readonly createChurch: CreateChurchUseCase,
    @Inject(GetChurchUseCase) private readonly getChurch: GetChurchUseCase,
    @Inject(UpdateChurchUseCase)
    private readonly updateChurch: UpdateChurchUseCase,
    @Inject(PresignLogoUseCase)
    private readonly presignLogo: PresignLogoUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  create(
    @RequiredAuth() auth: AuthContext,
    @Body(zod(CreateChurchBody)) body: z.infer<typeof CreateChurchBody>,
  ): Promise<MeView> {
    return this.createChurch.execute(auth, body);
  }

  @Get()
  get(@CurrentChurchId() churchId: string): Promise<ChurchView> {
    return this.getChurch.execute(churchId);
  }

  @Patch()
  update(
    @CurrentChurchId() churchId: string,
    @Body(zod(UpdateChurchBody)) body: z.infer<typeof UpdateChurchBody>,
  ): Promise<ChurchView> {
    return this.updateChurch.execute(churchId, body);
  }

  @Post('logo/presign')
  @HttpCode(200)
  async presign(
    @CurrentChurchId() churchId: string,
    @Body(zod(PresignBody)) body: z.infer<typeof PresignBody>,
  ): Promise<PresignedUploadResponse> {
    return toPresignedUploadResponse(
      await this.presignLogo.execute(churchId, body),
    );
  }
}
