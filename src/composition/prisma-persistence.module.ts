import { Global, Module, type Provider } from '@nestjs/common';
import {
  AI_USAGE_RECORDER,
  USAGE_METER,
} from '../shared/application/ports/usage-meter.port.js';
import { ANALYTICS_QUERY } from '../modules/analytics/analytics.repository.js';
import { PrismaAnalyticsQuery } from '../modules/analytics/analytics.repository.js';
import {
  AUTH_REPOSITORY,
  PrismaAuthRepository,
} from '../modules/auth/auth.repository.js';
import { SUBSCRIPTION_REPOSITORY } from '../modules/billing/billing.repository.js';
import { PrismaSubscriptionRepository } from '../modules/billing/billing.repository.js';
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
import {
  INTEGRATION_REPOSITORY,
  PrismaIntegrationRepository,
  PrismaPublishingRepository,
  PUBLISHING_REPOSITORY,
} from '../modules/integrations/integrations.repository.js';
import { LIBRARY_FACETS } from '../modules/library/library.repository.js';
import { PrismaLibraryFacets } from '../modules/library/library.repository.js';
import { SERMON_QUERY, SERMON_REPOSITORY } from '../modules/sermons/sermons.repository.js';
import { EMBEDDING_REPOSITORY, INTELLIGENCE_REPOSITORY, TRANSCRIPT_REPOSITORY } from '../modules/sermons/sermons.repository.js';
import { PrismaSermonQuery, PrismaSermonRepository } from '../modules/sermons/sermons.repository.js';
import { PrismaEmbeddingRepository, PrismaIntelligenceRepository, PrismaTranscriptRepository } from '../modules/sermons/sermons.repository.js';
import { UPLOAD_REPOSITORY } from '../modules/uploads/uploads.repository.js';
import { PrismaUploadRepository } from '../modules/uploads/uploads.repository.js';
import { USAGE_QUERY } from '../modules/usage/usage.repository.js';
import {
  PrismaAIUsageRecorder,
  PrismaUsageMeter,
  PrismaUsageQuery,
} from '../modules/usage/usage.repository.js';

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
} from '../modules/social/social.repository.js';
import {
  PrismaSocialAuditLog,
  PrismaSocialConnectionRepository,
  PrismaSocialPostRepository,
} from '../modules/social/social.repository.js';

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
