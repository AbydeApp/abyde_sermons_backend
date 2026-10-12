import { Module } from '@nestjs/common';
import { BrandModule } from '../brand/brand.module.js';
import {
  REEL_BRAND,
  REEL_MEDIA,
  REEL_SOURCE,
} from './application/ports/out/reel.ports.js';
import { ReelPresenter } from './application/reel-presenter.js';
import { ReelCandidateAIService } from './application/services/reel-candidate-ai.service.js';
import { ReelHookAIService } from './application/services/reel-hook-ai.service.js';
import {
  GenerateReelCandidatesUseCase,
  ListReelCandidatesUseCase,
  RegenerateReelCandidatesUseCase,
} from './application/use-cases/reel-candidates.use-cases.js';
import {
  RecoverStuckReelsUseCase,
  RenderReelUseCase,
  RequestReelRenderUseCase,
} from './application/use-cases/reel-render.use-cases.js';
import {
  ApproveReelUseCase,
  CreateReelUseCase,
  DeleteReelUseCase,
  GenerateReelHooksUseCase,
  GetReelUseCase,
  ListReelsUseCase,
  UpdateReelUseCase,
} from './application/use-cases/reels.use-cases.js';
import { ReelBrandAdapter } from './infrastructure/reel-brand.adapter.js';
import { ReelMediaAdapter } from './infrastructure/reel-media.adapter.js';
import { ReelSourceAdapter } from './infrastructure/reel-source.adapter.js';
import { ReelsController } from './presentation/http/reels.controller.js';
import { ReelJobHandlers } from './presentation/queue/reel-job.handlers.js';

/**
 * Reels: candidate selection from the sermon, AI hooks, branded 9:16 renders of the pastor's real
 * video and voice. Repositories, renderer, speaker tracker and settings are bound by the
 * composition root; the adapters here only bridge to other modules' ports.
 */
@Module({
  imports: [BrandModule],
  controllers: [ReelsController],
  providers: [
    ReelPresenter,
    ReelCandidateAIService,
    ReelHookAIService,
    GenerateReelCandidatesUseCase,
    ListReelCandidatesUseCase,
    RegenerateReelCandidatesUseCase,
    CreateReelUseCase,
    GetReelUseCase,
    ListReelsUseCase,
    UpdateReelUseCase,
    GenerateReelHooksUseCase,
    ApproveReelUseCase,
    DeleteReelUseCase,
    RequestReelRenderUseCase,
    RenderReelUseCase,
    RecoverStuckReelsUseCase,
    ReelJobHandlers,
    { provide: REEL_SOURCE, useClass: ReelSourceAdapter },
    { provide: REEL_BRAND, useClass: ReelBrandAdapter },
    { provide: REEL_MEDIA, useClass: ReelMediaAdapter },
  ],
})
export class ReelsModule {}
