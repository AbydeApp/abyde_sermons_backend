import { Module } from '@nestjs/common';
import { SOCIAL_MEDIA_LIBRARY } from './application/ports/out/social-support.ports.js';
import { ConnectionAccessService } from './application/connection-access.service.js';
import { PostValidator } from './application/post-validator.js';
import {
  CompleteSocialAuthorizationUseCase,
  ConnectionWriter,
  DisconnectSocialConnectionUseCase,
  GetConnectionCapabilitiesUseCase,
  GetSocialCapabilitiesUseCase,
  ListSocialConnectionsUseCase,
  SocialAccountSelectionUseCase,
  StartSocialAuthorizationUseCase,
} from './application/use-cases/connection.use-cases.js';
import {
  CreateSocialPostUseCase,
  DeleteSocialPostUseCase,
  GetSocialPostUseCase,
  ListSocialPostsUseCase,
  PrePublishCheck,
  PublishSocialPostUseCase,
  RetrySocialPostUseCase,
  ScheduleSocialPostUseCase,
  SocialPostPlanner,
  UpdateSocialPostUseCase,
} from './application/use-cases/post.use-cases.js';
import {
  CollectPublicationMetricsUseCase,
  DispatchDueSocialPostsUseCase,
  PublicationDispatcher,
  PublishPublicationUseCase,
  RefreshExpiringConnectionsUseCase,
} from './application/use-cases/publishing.use-cases.js';
import { SocialMediaLibraryAdapter } from './infrastructure/social-media-library.adapter.js';
import { SocialConnectionsController } from './presentation/http/social-connections.controller.js';
import { SocialPostsController } from './presentation/http/social-posts.controller.js';
import { SocialJobHandlers } from './presentation/queue/social-job.handlers.js';

/**
 * Direct social publishing: OAuth connections, posts with one publication per target, scheduling,
 * workers, retries and status. Provider adapters, repositories and the token cipher are bound by
 * the composition root.
 */
@Module({
  controllers: [SocialConnectionsController, SocialPostsController],
  providers: [
    ConnectionAccessService,
    PostValidator,
    ConnectionWriter,
    ListSocialConnectionsUseCase,
    StartSocialAuthorizationUseCase,
    CompleteSocialAuthorizationUseCase,
    SocialAccountSelectionUseCase,
    DisconnectSocialConnectionUseCase,
    GetSocialCapabilitiesUseCase,
    GetConnectionCapabilitiesUseCase,
    SocialPostPlanner,
    PrePublishCheck,
    CreateSocialPostUseCase,
    UpdateSocialPostUseCase,
    GetSocialPostUseCase,
    ListSocialPostsUseCase,
    DeleteSocialPostUseCase,
    PublishSocialPostUseCase,
    ScheduleSocialPostUseCase,
    RetrySocialPostUseCase,
    PublicationDispatcher,
    PublishPublicationUseCase,
    DispatchDueSocialPostsUseCase,
    RefreshExpiringConnectionsUseCase,
    CollectPublicationMetricsUseCase,
    SocialJobHandlers,
    { provide: SOCIAL_MEDIA_LIBRARY, useClass: SocialMediaLibraryAdapter },
  ],
})
export class SocialModule {}
