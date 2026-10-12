import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { notFound } from '../../../../shared/domain/domain-error.js';
import { CurrentChurchId } from '../../../../shared/infrastructure/http/auth.decorators.js';
import { ParseIdPipe } from '../../../../shared/infrastructure/http/uuid.pipe.js';
import { zod } from '../../../../shared/infrastructure/http/zod-validation.pipe.js';
import { toPresignedUploadResponse } from '../../../uploads/presentation/http/presigned-upload.response.js';
import {
  EMOJI_USAGE,
  isContentType,
  WATERMARK_POSITIONS,
} from '../../domain/brand-profile.js';
import { ASPECT_NAMES } from '../../domain/templates.js';
import {
  CAPTION_POSITIONS,
  CAPTION_STYLES,
  HOOK_STYLES,
  LOGO_POSITIONS,
} from '../../domain/video-settings.js';
import {
  DeleteBrandAssetUseCase,
  GetBrandProfileUseCase,
  ListTemplatesUseCase,
  PresignBrandAssetUseCase,
  PreviewBrandUseCase,
  SetDefaultTemplateUseCase,
  UpdateBrandProfileUseCase,
} from '../../application/use-cases/brand-profile.use-cases.js';

const term = z.string().max(80);

const VoiceBody = z.strictObject({
  tone: z.string().max(200),
  bibleTranslation: z.string().max(20).nullable(),
  emojiUsage: z.enum(EMOJI_USAGE, { error: 'Unknown emoji usage' }),
  writingStyle: z.string().max(500).nullable(),
  preferredTerms: z
    .array(z.strictObject({ preferred: term, insteadOf: term.optional() }))
    .max(50),
  avoidPhrases: z.array(term).max(50),
  ctaStyle: z.string().max(200).nullable(),
  hashtagPreferences: z.array(z.string().max(60)).max(30),
});

/** Everything optional: PUT replaces the fields it carries; `null` clears an optional field. */
const LookFields = {
  churchName: z.string().max(120),
  primaryColor: z.string().max(7),
  secondaryColor: z.string().max(7),
  accentColor: z.string().max(7),
  headingFont: z.string().max(60),
  bodyFont: z.string().max(60),
  socialHandle: z.string().max(51).nullable(),
  website: z.string().max(255).nullable(),
  watermarkEnabled: z.boolean(),
  watermarkPosition: z
    .enum(WATERMARK_POSITIONS, { error: 'Unknown watermark position' })
    .nullable(),
  voice: VoiceBody.partial(),
};

const VideoSettingsBody = z
  .strictObject({
    hookStyle: z.enum(HOOK_STYLES, { error: 'Unknown hook style' }),
    captionStyle: z.enum(CAPTION_STYLES, { error: 'Unknown caption style' }),
    captionPosition: z.enum(CAPTION_POSITIONS, {
      error: 'Unknown caption position',
    }),
    logoPosition: z.enum(LOGO_POSITIONS, { error: 'Unknown logo position' }),
    showSpeakerName: z.boolean(),
    showChurchName: z.boolean(),
    outroEnabled: z.boolean(),
  })
  .partial();

const BrandBody = z
  .strictObject({
    ...LookFields,
    logoAssetId: z.string().uuid('Invalid asset id').nullable(),
    alternateLogoAssetId: z.string().uuid('Invalid asset id').nullable(),
    videoSettings: VideoSettingsBody,
  })
  .partial();

const PresignBody = z.strictObject({
  fileName: z.string().min(1, 'File name is required').max(255),
  contentType: z.string().min(1).max(255),
  sizeBytes: z.number({ error: 'File size is required' }).int().positive(),
});

const DefaultTemplateBody = z.strictObject({
  templateId: z.string().min(1).max(60),
});

const PreviewBody = z.strictObject({
  text: z.string().trim().min(1, 'Text is required').max(600),
  heading: z.string().max(120).optional(),
  attribution: z.string().max(120).optional(),
  templateId: z.string().max(60).optional(),
  aspect: z.enum(ASPECT_NAMES).default('square'),
  brand: z.strictObject(LookFields).partial().optional(),
});

/** `null` in the body clears a field; the domain treats `undefined` as "unchanged". */
const nullsToUndefined = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, entry ?? undefined]),
  );

@ApiTags('brand-studio')
@Controller('brand-studio')
export class BrandStudioController {
  constructor(
    @Inject(GetBrandProfileUseCase)
    private readonly getProfile: GetBrandProfileUseCase,
    @Inject(UpdateBrandProfileUseCase)
    private readonly updateProfile: UpdateBrandProfileUseCase,
    @Inject(PresignBrandAssetUseCase)
    private readonly presignAsset: PresignBrandAssetUseCase,
    @Inject(DeleteBrandAssetUseCase)
    private readonly deleteAsset: DeleteBrandAssetUseCase,
    @Inject(ListTemplatesUseCase)
    private readonly listTemplates: ListTemplatesUseCase,
    @Inject(SetDefaultTemplateUseCase)
    private readonly setDefault: SetDefaultTemplateUseCase,
    @Inject(PreviewBrandUseCase) private readonly preview: PreviewBrandUseCase,
  ) {}

  @Get()
  get(@CurrentChurchId() churchId: string) {
    return this.getProfile.execute(churchId);
  }

  @Put()
  update(
    @CurrentChurchId() churchId: string,
    @Body(zod(BrandBody)) body: z.infer<typeof BrandBody>,
  ) {
    const { voice, ...rest } = body;
    return this.updateProfile.execute(churchId, {
      ...rest,
      voice: voice
        ? (nullsToUndefined(voice) as Parameters<
            UpdateBrandProfileUseCase['execute']
          >[1]['voice'])
        : undefined,
    });
  }

  @Post('assets/presign')
  @HttpCode(200)
  async presign(
    @CurrentChurchId() churchId: string,
    @Body(zod(PresignBody)) body: z.infer<typeof PresignBody>,
  ) {
    const presigned = await this.presignAsset.execute({ churchId, ...body });
    return {
      assetId: presigned.assetId,
      ...toPresignedUploadResponse(presigned),
    };
  }

  @Delete('assets/:assetId')
  @HttpCode(204)
  async removeAsset(
    @CurrentChurchId() churchId: string,
    @Param('assetId', new ParseIdPipe('Brand asset')) assetId: string,
  ): Promise<void> {
    await this.deleteAsset.execute(churchId, assetId);
  }

  @Get('templates')
  templates(@CurrentChurchId() churchId: string) {
    return this.listTemplates.execute(churchId);
  }

  @Put('templates/:contentType/default')
  setTemplateDefault(
    @CurrentChurchId() churchId: string,
    @Param('contentType') contentType: string,
    @Body(zod(DefaultTemplateBody)) body: z.infer<typeof DefaultTemplateBody>,
  ) {
    const type = contentType.toUpperCase();
    if (!isContentType(type)) throw notFound('Content type');
    return this.setDefault.execute(churchId, type, body.templateId);
  }

  @Post('preview')
  @HttpCode(200)
  previewCard(
    @CurrentChurchId() churchId: string,
    @Body(zod(PreviewBody)) body: z.infer<typeof PreviewBody>,
  ) {
    const { brand, ...rest } = body;
    return this.preview.execute(churchId, {
      ...rest,
      brand: brand
        ? {
            ...brand,
            voice: undefined,
          }
        : undefined,
    });
  }
}
