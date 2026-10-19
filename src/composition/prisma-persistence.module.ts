import { Global, Module, type Provider } from '@nestjs/common';
import {
  AI_USAGE_RECORDER,
  USAGE_METER,
} from '../shared/application/ports/usage-meter.port.js';
import { ANALYTICS_QUERY } from '../modules/analytics/application/ports/out/analytics-query.port.js';
import { PrismaAnalyticsQuery } from '../modules/analytics/infrastructure/prisma-analytics.query.js';
import {
  AUTH_REPOSITORY,
  PrismaAuthRepository,
} from '../modules/auth/auth.repository.js';
import { SUBSCRIPTION_REPOSITORY } from '../modules/billing/application/ports/out/billing.ports.js';
import { PrismaSubscriptionRepository } from '../modules/billing/infrastructure/persistence/prisma-subscription.repository.js';
import {
  CALENDAR_REPOSITORY,
  CONTENT_QUERY,
  CONTENT_REPOSITORY,
  GENERATION_REPOSITORY,
} from '../modules/content/content.repository.js';
import {
  PrismaCalendarRepository,
  PrismaContentQuery,
  PrismaContentRepository,
  PrismaGenerationRepository,
} from '../modules/content/content.repository.js';
import { INTEGRATION_REPOSITORY } from '../modules/integrations/application/ports/out/integration.ports.js';
import { PrismaIntegrationRepository } from '../modules/integrations/infrastructure/persistence/prisma-integration.repository.js';
import { LIBRARY_FACETS } from '../modules/library/application/ports/out/library-facets.port.js';
import { PrismaLibraryFacets } from '../modules/library/infrastructure/prisma-library-facets.js';
import { PUBLISHING_REPOSITORY } from '../modules/publishing/application/ports/out/publishing.ports.js';
import { PrismaPublishingRepository } from '../modules/publishing/infrastructure/persistence/prisma-publishing.repository.js';
import {
  SERMON_QUERY,
  SERMON_REPOSITORY,
} from '../modules/sermons/application/ports/out/sermon-repository.port.js';
import {
  EMBEDDING_REPOSITORY,
  INTELLIGENCE_REPOSITORY,
  TRANSCRIPT_REPOSITORY,
} from '../modules/sermons/application/ports/out/transcript-repository.port.js';
import {
  PrismaSermonQuery,
  PrismaSermonRepository,
} from '../modules/sermons/infrastructure/persistence/prisma-sermon.repositories.js';
import {
  PrismaEmbeddingRepository,
  PrismaIntelligenceRepository,
  PrismaTranscriptRepository,
} from '../modules/sermons/infrastructure/persistence/prisma-transcript.repositories.js';
import { UPLOAD_REPOSITORY } from '../modules/uploads/application/ports/out/upload-repository.port.js';
import { PrismaUploadRepository } from '../modules/uploads/infrastructure/persistence/prisma-upload.repository.js';
import { USAGE_QUERY } from '../modules/usage/application/ports/out/usage-query.port.js';
import {
  PrismaAIUsageRecorder,
  PrismaUsageMeter,
  PrismaUsageQuery,
} from '../modules/usage/infrastructure/prisma-usage.adapters.js';

import {
  BRAND_PROFILE_REPOSITORY,
  MEDIA_ASSET_REPOSITORY,
  PrismaBrandProfileRepository,
  PrismaMediaAssetRepository,
} from '../modules/brand/brand.repository.js';
import {
  SOCIAL_AUDIT_LOG,
  SOCIAL_CONNECTION_REPOSITORY,
  SOCIAL_POST_REPOSITORY,
} from '../modules/social/application/ports/out/social-repositories.port.js';
import {
  PrismaSocialAuditLog,
  PrismaSocialConnectionRepository,
  PrismaSocialPostRepository,
} from '../modules/social/infrastructure/persistence/prisma-social.repositories.js';

/** Binds every repository port to its Prisma adapter (the only place Prisma repositories are chosen). */
export const PRISMA_REPOSITORIES: Provider[] = [
  { provide: AUTH_REPOSITORY, useClass: PrismaAuthRepository },
  { provide: UPLOAD_REPOSITORY, useClass: PrismaUploadRepository },
  { provide: SERMON_REPOSITORY, useClass: PrismaSermonRepository },
  { provide: SERMON_QUERY, useClass: PrismaSermonQuery },
  { provide: TRANSCRIPT_REPOSITORY, useClass: PrismaTranscriptRepository },
  { provide: INTELLIGENCE_REPOSITORY, useClass: PrismaIntelligenceRepository },
  { provide: EMBEDDING_REPOSITORY, useClass: PrismaEmbeddingRepository },
  { provide: CONTENT_REPOSITORY, useClass: PrismaContentRepository },
  { provide: CONTENT_QUERY, useClass: PrismaContentQuery },
  { provide: CALENDAR_REPOSITORY, useClass: PrismaCalendarRepository },
  { provide: GENERATION_REPOSITORY, useClass: PrismaGenerationRepository },
  { provide: USAGE_METER, useClass: PrismaUsageMeter },
  { provide: AI_USAGE_RECORDER, useClass: PrismaAIUsageRecorder },
  { provide: USAGE_QUERY, useClass: PrismaUsageQuery },
  { provide: SUBSCRIPTION_REPOSITORY, useClass: PrismaSubscriptionRepository },
  { provide: INTEGRATION_REPOSITORY, useClass: PrismaIntegrationRepository },
  { provide: PUBLISHING_REPOSITORY, useClass: PrismaPublishingRepository },
  { provide: LIBRARY_FACETS, useClass: PrismaLibraryFacets },
  { provide: ANALYTICS_QUERY, useClass: PrismaAnalyticsQuery },
  { provide: BRAND_PROFILE_REPOSITORY, useClass: PrismaBrandProfileRepository },
  { provide: MEDIA_ASSET_REPOSITORY, useClass: PrismaMediaAssetRepository },
  {
    provide: SOCIAL_CONNECTION_REPOSITORY,
    useClass: PrismaSocialConnectionRepository,
  },
  { provide: SOCIAL_POST_REPOSITORY, useClass: PrismaSocialPostRepository },
  { provide: SOCIAL_AUDIT_LOG, useClass: PrismaSocialAuditLog },
];

@Global()
@Module({
  providers: PRISMA_REPOSITORIES,
  exports: PRISMA_REPOSITORIES.map(
    (provider) => (provider as { provide: symbol }).provide,
  ),
})
export class PrismaPersistenceModule {}
