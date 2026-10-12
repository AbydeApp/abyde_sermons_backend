import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentChurchId } from '../../../../shared/infrastructure/http/auth.decorators.js';
import {
  pageQuery,
  pageRequest,
  type PaginatedResponse,
  toPaginated,
} from '../../../../shared/infrastructure/http/pagination.js';
import { ParseIdPipe } from '../../../../shared/infrastructure/http/uuid.pipe.js';
import { zod } from '../../../../shared/infrastructure/http/zod-validation.pipe.js';
import type { SermonStatus } from '../../domain/processing.js';
import {
  CreateSermonUseCase,
  DeleteSermonUseCase,
  GetIntelligenceUseCase,
  GetSermonStatusUseCase,
  GetSermonUseCase,
  GetTranscriptUseCase,
  ListSermonsUseCase,
  RetrySermonUseCase,
  type SermonStatusInfo,
  UpdateSermonUseCase,
} from '../../application/use-cases/sermon-crud.use-cases.js';
import {
  type SermonResponse,
  toIntelligenceResponse,
  toSegmentResponse,
  toSermonResponse,
} from './sermon.responses.js';

const STATUSES = [
  'UPLOADING',
  'UPLOADED',
  'QUEUED',
  'TRANSCRIBING',
  'ANALYZING',
  'INDEXING',
  'READY',
  'FAILED',
  'ARCHIVED',
] as const;

const isoDate = z
  .string({ error: 'Sermon date is required' })
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Enter a valid date')
  .transform((value) => new Date(value));
const tags = z.array(z.string().max(40)).max(20);

const CreateSermonBody = z.object({
  title: z
    .string({ error: 'Title is required' })
    .min(1, 'Title is required')
    .max(200),
  speaker: z
    .string({ error: 'Speaker is required' })
    .min(1, 'Speaker is required')
    .max(120),
  sermonDate: isoDate,
  series: z.string().max(120).nullable().optional(),
  mainScripture: z.string().max(120).nullable().optional(),
  tags: tags.optional(),
  objectKey: z.string().max(512).optional(),
  transcriptText: z.string().max(1_000_000).optional(),
});

const UpdateSermonBody = z
  .object({
    title: z.string().max(200),
    speaker: z.string().max(120),
    sermonDate: isoDate,
    series: z.string().max(120).nullable(),
    mainScripture: z.string().max(120).nullable(),
    tags,
  })
  .partial()
  .strict();

const ListQuery = z.object({
  status: z
    .string()
    .optional()
    .transform((value) =>
      value
        ?.split(',')
        .map((status) => status.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(STATUSES, { error: 'Unknown status' })).optional()),
  q: z.string().trim().max(200).optional(),
  ...pageQuery,
});

@ApiTags('sermons')
@Controller('sermons')
export class SermonsController {
  constructor(
    @Inject(CreateSermonUseCase)
    private readonly createSermon: CreateSermonUseCase,
    @Inject(ListSermonsUseCase)
    private readonly listSermons: ListSermonsUseCase,
    @Inject(GetSermonUseCase) private readonly getSermon: GetSermonUseCase,
    @Inject(UpdateSermonUseCase)
    private readonly updateSermon: UpdateSermonUseCase,
    @Inject(DeleteSermonUseCase)
    private readonly deleteSermon: DeleteSermonUseCase,
    @Inject(GetSermonStatusUseCase)
    private readonly getStatus: GetSermonStatusUseCase,
    @Inject(RetrySermonUseCase)
    private readonly retrySermon: RetrySermonUseCase,
    @Inject(GetTranscriptUseCase)
    private readonly getTranscript: GetTranscriptUseCase,
    @Inject(GetIntelligenceUseCase)
    private readonly getIntelligence: GetIntelligenceUseCase,
  ) {}

  @Post()
  @HttpCode(202)
  create(
    @CurrentChurchId() churchId: string,
    @Body(zod(CreateSermonBody)) body: z.infer<typeof CreateSermonBody>,
  ): Promise<{ id: string }> {
    return this.createSermon.execute(churchId, body);
  }

  @Get()
  async list(
    @CurrentChurchId() churchId: string,
    @Query(zod(ListQuery)) query: z.infer<typeof ListQuery>,
  ): Promise<PaginatedResponse<SermonResponse>> {
    const page = await this.listSermons.execute(
      churchId,
      {
        statuses: query.status as SermonStatus[] | undefined,
        q: query.q || undefined,
      },
      pageRequest(query),
    );
    return toPaginated(page, toSermonResponse);
  }

  @Get(':id')
  async get(
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Sermon')) id: string,
  ): Promise<SermonResponse> {
    return toSermonResponse(await this.getSermon.execute(churchId, id));
  }

  @Patch(':id')
  async update(
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Sermon')) id: string,
    @Body(zod(UpdateSermonBody)) body: z.infer<typeof UpdateSermonBody>,
  ): Promise<SermonResponse> {
    return toSermonResponse(
      await this.updateSermon.execute(churchId, id, body),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Sermon')) id: string,
  ): Promise<void> {
    await this.deleteSermon.execute(churchId, id);
  }

  @Get(':id/status')
  status(
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Sermon')) id: string,
  ): Promise<SermonStatusInfo> {
    return this.getStatus.execute(churchId, id);
  }

  @Post(':id/status/retry')
  @HttpCode(202)
  retry(
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Sermon')) id: string,
  ): Promise<SermonStatusInfo> {
    return this.retrySermon.execute(churchId, id);
  }

  @Get(':id/transcript')
  async transcript(
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Sermon')) id: string,
  ) {
    return (await this.getTranscript.execute(churchId, id)).map(
      toSegmentResponse,
    );
  }

  @Get(':id/intelligence')
  async intelligence(
    @CurrentChurchId() churchId: string,
    @Param('id', new ParseIdPipe('Sermon')) id: string,
  ) {
    return toIntelligenceResponse(
      await this.getIntelligence.execute(churchId, id),
    );
  }
}
