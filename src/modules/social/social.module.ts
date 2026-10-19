import { Module } from '@nestjs/common';
import { SOCIAL_MEDIA_LIBRARY } from './adapters/ports.js';
import { SocialMediaLibraryAdapter } from './adapters/social-media-library.adapter.js';
import { ConnectionsService } from './connections.service.js';
import { PostsService } from './posts.service.js';
import { PublishingService } from './publishing.service.js';
import { SocialConnectionsController, SocialPostsController } from './social.controller.js';

/**
 * Direct social publishing: OAuth connections, posts with one publication per target, scheduling,
 * workers, retries and status. Provider adapters, repositories and the token cipher are bound by
 * the composition root.
 */
@Module({
  controllers: [SocialConnectionsController, SocialPostsController],
  providers: [
    ConnectionsService,
    PublishingService,
    PostsService,
    { provide: SOCIAL_MEDIA_LIBRARY, useClass: SocialMediaLibraryAdapter },
  ],
})
export class SocialModule {}
