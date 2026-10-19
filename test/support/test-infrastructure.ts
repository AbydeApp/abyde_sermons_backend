import { type DynamicModule, Global, Module } from '@nestjs/common';
import { LocksModule } from '@nestjs/locks';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import {
  JOB_HANDLER_REGISTRY,
  JobHandlerRegistry,
} from '../../src/shared/application/jobs.js';
import { CACHE } from '../../src/shared/application/ports/cache.port.js';
import { CLOCK } from '../../src/shared/application/ports/clock.port.js';
import { EMAIL_SENDER } from '../../src/shared/application/ports/email.port.js';
import { LANGUAGE_MODEL } from '../../src/shared/application/ports/language-model.port.js';
import { QUEUE } from '../../src/shared/application/ports/queue.port.js';
import {
  SECRET_BOX,
  TOKEN_GENERATOR,
} from '../../src/shared/application/ports/secret-box.port.js';
import { STORAGE } from '../../src/shared/application/ports/storage.port.js';
import { UNIT_OF_WORK } from '../../src/shared/application/ports/unit-of-work.port.js';
import {
  AI_USAGE_RECORDER,
  USAGE_METER,
} from '../../src/shared/application/ports/usage-meter.port.js';
import { FakeLanguageModel } from '../../src/shared/infrastructure/ai/fake-language-model.js';
import { MeteredLanguageModel } from '../../src/shared/infrastructure/ai/metered-language-model.js';
import { InMemoryCacheAdapter } from './in-memory-cache.adapter.js';
import { AesGcmSecretBox } from '../../src/shared/infrastructure/crypto/aes-gcm-secret-box.js';
import { RandomTokenGenerator } from '../../src/shared/infrastructure/crypto/random-token-generator.js';
import { RecordingEmailAdapter } from './recording-email.adapter.js';
import { MetricsService } from '../../src/shared/infrastructure/observability/metrics.service.js';
import { InMemoryQueueAdapter } from './in-memory-queue.adapter.js';
import { JOB_OBSERVER } from '../../src/shared/infrastructure/queue/job-observer.js';
import { InMemoryStorageAdapter } from './in-memory-storage.adapter.js';
import { THROTTLER_STORAGE } from '../../src/composition/tokens.js';
import { ANALYTICS_QUERY } from '../../src/modules/analytics/analytics.repository.js';
import { AUTH_REPOSITORY } from '../../src/modules/auth/auth.repository.js';
import { BILLING_SETTINGS, PAYMENT_PROVIDER } from '../../src/modules/billing/adapters/ports.js';
import { SUBSCRIPTION_REPOSITORY } from '../../src/modules/billing/billing.repository.js';
import { FakePaymentAdapter } from '../../src/modules/billing/adapters/fake-payment.adapter.js';
import {
  CALENDAR_REPOSITORY,
  CONTENT_QUERY,
  CONTENT_REPOSITORY,
  GENERATION_REPOSITORY,
} from '../../src/modules/content/content.repository.js';
import { READINESS_CHECKS } from '../../src/modules/health/helper.js';
import { INTEGRATION_REPOSITORY } from '../../src/modules/integrations/integrations.repository.js';
import { INTEGRATION_SETTINGS, OAUTH_PROVIDERS } from '../../src/modules/integrations/adapters/ports.js';
import {
  GROUNDED_ANSWER,
  SEGMENT_SEARCH,
} from '../../src/modules/library/adapters/ports.js';
import { AIGroundedAnswerAdapter } from '../../src/modules/library/adapters/ai-grounded-answer.adapter.js';
import { EmbeddingSegmentSearchAdapter } from '../../src/modules/library/adapters/embedding-segment-search.adapter.js';
import { LIBRARY_FACETS } from '../../src/modules/library/library.repository.js';
import { PUBLISHING_PROVIDERS } from '../../src/modules/integrations/adapters/ports.js';
import { PUBLISHING_REPOSITORY } from '../../src/modules/integrations/integrations.repository.js';
import { FakePublisher } from './fake-publisher.js';
import {
  DOCUMENT_TEXT_EXTRACTOR,
  MEDIA_PROCESSOR,
  SCRATCH_SPACE,
  TRANSCRIPTION,
} from '../../src/modules/sermons/adapters/ports.js';
import { SERMON_QUERY, SERMON_REPOSITORY } from '../../src/modules/sermons/sermons.repository.js';
import { EMBEDDING_REPOSITORY, INTELLIGENCE_REPOSITORY, TRANSCRIPT_REPOSITORY } from '../../src/modules/sermons/sermons.repository.js';
import { DocumentTextExtractor } from '../../src/modules/sermons/adapters/document-text-extractor.js';
import { OsScratchSpace } from '../../src/modules/sermons/adapters/os-scratch-space.js';
import { FakeTranscriptionAdapter } from '../../src/modules/sermons/adapters/fake-transcription.adapter.js';
import {
  emptyQueueInspector,
  QUEUE_INSPECTOR,
} from '../../src/modules/system/queue-inspector.js';
import { UPLOAD_REPOSITORY } from '../../src/modules/uploads/uploads.repository.js';
import { USAGE_QUERY } from '../../src/modules/usage/usage.repository.js';
import { InMemoryDb, InMemoryUnitOfWork, TestClock } from './in-memory-db.js';
import {
  InMemoryAIUsageRecorder,
  InMemoryAnalyticsQuery,
  InMemoryCalendarRepository,
  InMemoryContentQuery,
  InMemoryContentRepository,
  InMemoryAuthRepository,
  InMemoryEmbeddingRepository,
  InMemoryGenerationRepository,
  InMemoryIntegrationRepository,
  InMemoryIntelligenceRepository,
  InMemoryLibraryFacets,
  InMemoryPublishingRepository,
  InMemorySermonQuery,
  InMemorySermonRepository,
  InMemorySubscriptionRepository,
  InMemoryTranscriptRepository,
  InMemoryUploadRepository,
  InMemoryUsage,
} from './in-memory-repositories.js';
import { FakeMediaProcessor, FakeOAuthProvider } from './fakes.js';
import {
  BRAND_RENDERER,
  MEDIA_OBSERVER,
  MEDIA_SETTINGS,
} from '../../src/modules/brand/adapters/ports.js';
import {
  BRAND_PROFILE_REPOSITORY,
  MEDIA_ASSET_REPOSITORY,
} from '../../src/modules/brand/brand.repository.js';
import {
  SOCIAL_AUDIT_LOG,
  SOCIAL_CONNECTION_REPOSITORY,
  SOCIAL_POST_REPOSITORY,
} from '../../src/modules/social/application/ports/out/social-repositories.port.js';
import { SOCIAL_PROVIDER_REGISTRY } from '../../src/modules/social/application/ports/out/social-publishing.port.js';
import {
  SOCIAL_OBSERVER,
  SOCIAL_SETTINGS,
  SOCIAL_TOKEN_CIPHER,
} from '../../src/modules/social/application/ports/out/social-support.ports.js';
import type { SocialProviderId } from '../../src/modules/social/domain/social-platform.js';
import { SocialProviderRegistry } from '../../src/modules/social/infrastructure/social-provider.registry.js';
import { AesGcmTokenCipher } from '../../src/shared/infrastructure/crypto/aes-gcm-token-cipher.js';
import {
  InMemoryBrandProfileRepository,
  InMemoryMediaAssetRepository,
  InMemorySocialAuditLog,
  InMemorySocialConnectionRepository,
  InMemorySocialPostRepository,
} from './in-memory-social.js';
import {
  FakeBrandRenderer,
  FakeSocialAdapter,
  recordingSocialObserver,
} from './social-fakes.js';

/** Handles to the in-memory infrastructure so tests can drive queues, time, storage and fakes. */
export class TestInfrastructure {
  readonly db = new InMemoryDb();
  readonly clock = new TestClock();
  readonly registry = new JobHandlerRegistry();
  readonly queue = new InMemoryQueueAdapter(this.registry);
  readonly storage = new InMemoryStorageAdapter();
  readonly email = new RecordingEmailAdapter();
  readonly model = new FakeLanguageModel();
  readonly cache = new InMemoryCacheAdapter(() => this.clock.now().getTime());
  readonly emailPublisher = new FakePublisher('EMAIL');
  readonly paymentProvider = new FakePaymentAdapter('http://web.test');
  readonly renderer = new FakeBrandRenderer();
  readonly socialObserver = recordingSocialObserver();
  readonly social: Record<SocialProviderId, FakeSocialAdapter> = {
    meta: new FakeSocialAdapter('meta'),
    tiktok: new FakeSocialAdapter('tiktok'),
    youtube: new FakeSocialAdapter('youtube'),
    x: new FakeSocialAdapter('x'),
    linkedin: new FakeSocialAdapter('linkedin'),
  };
  readonly tokenCipher = new AesGcmTokenCipher(
    createHash('sha256').update('social-test-key').digest('base64'),
  );

  module(): DynamicModule {
    const db = this.db;
    const clock = this.clock;
    const usage = new InMemoryUsage(db, clock);
    const aiRecorder = new InMemoryAIUsageRecorder(db, clock);
    const model = new MeteredLanguageModel(
      this.model,
      'fake',
      { text: 'fake-1', embedding: 'fake-embedding-1' },
      { textInputPerMTok: 0, textOutputPerMTok: 0, embeddingPerMTok: 0 },
      aiRecorder,
      usage,
    );
    const embeddings = new InMemoryEmbeddingRepository(db);
    const values: Array<[symbol, unknown]> = [
      [CLOCK, clock],
      [CACHE, this.cache],
      [QUEUE, this.queue],
      [JOB_HANDLER_REGISTRY, this.registry],
      [UNIT_OF_WORK, new InMemoryUnitOfWork(db)],
      [TOKEN_GENERATOR, new RandomTokenGenerator()],
      [
        SECRET_BOX,
        new AesGcmSecretBox(
          createHash('sha256').update('test-key').digest('base64'),
        ),
      ],
      [THROTTLER_STORAGE, new ThrottlerStorageService()],
      [QUEUE_INSPECTOR, emptyQueueInspector],
      [READINESS_CHECKS, []],
      [STORAGE, this.storage],
      [EMAIL_SENDER, this.email],
      [LANGUAGE_MODEL, model],
      // The real adapters (with their fallbacks) run over the in-memory doubles.
      [
        SEGMENT_SEARCH,
        new EmbeddingSegmentSearchAdapter(model, this.cache, embeddings),
      ],
      [GROUNDED_ANSWER, new AIGroundedAnswerAdapter(model)],
      [TRANSCRIPTION, new FakeTranscriptionAdapter()],
      [MEDIA_PROCESSOR, new FakeMediaProcessor()],
      [DOCUMENT_TEXT_EXTRACTOR, new DocumentTextExtractor()],
      [SCRATCH_SPACE, new OsScratchSpace()],
      [PAYMENT_PROVIDER, this.paymentProvider],
      [BILLING_SETTINGS, { webUrl: 'http://web.test' }],
      [
        INTEGRATION_SETTINGS,
        { webUrl: 'http://web.test', publicApiUrl: 'http://api.test/api/v1' },
      ],
      [
        OAUTH_PROVIDERS,
        [new FakeOAuthProvider('WHATSAPP'), new FakeOAuthProvider('EMAIL')],
      ],
      [PUBLISHING_PROVIDERS, [this.emailPublisher]],
      [AUTH_REPOSITORY, new InMemoryAuthRepository(db)],
      [UPLOAD_REPOSITORY, new InMemoryUploadRepository(db)],
      [SERMON_REPOSITORY, new InMemorySermonRepository(db, clock)],
      [SERMON_QUERY, new InMemorySermonQuery(db)],
      [TRANSCRIPT_REPOSITORY, new InMemoryTranscriptRepository(db)],
      [INTELLIGENCE_REPOSITORY, new InMemoryIntelligenceRepository(db)],
      [EMBEDDING_REPOSITORY, embeddings],
      [CONTENT_REPOSITORY, new InMemoryContentRepository(db)],
      [CONTENT_QUERY, new InMemoryContentQuery(db)],
      [CALENDAR_REPOSITORY, new InMemoryCalendarRepository(db, clock)],
      [GENERATION_REPOSITORY, new InMemoryGenerationRepository(db, clock)],
      [USAGE_METER, usage],
      [USAGE_QUERY, usage],
      [AI_USAGE_RECORDER, aiRecorder],
      [SUBSCRIPTION_REPOSITORY, new InMemorySubscriptionRepository(db, clock)],
      [INTEGRATION_REPOSITORY, new InMemoryIntegrationRepository(db)],
      [PUBLISHING_REPOSITORY, new InMemoryPublishingRepository(db, clock)],
      [LIBRARY_FACETS, new InMemoryLibraryFacets(db)],
      [ANALYTICS_QUERY, new InMemoryAnalyticsQuery(db)],
      [BRAND_PROFILE_REPOSITORY, new InMemoryBrandProfileRepository(db)],
      [MEDIA_ASSET_REPOSITORY, new InMemoryMediaAssetRepository(db, clock)],
      [BRAND_RENDERER, this.renderer],
      [MEDIA_OBSERVER, { rendered: () => undefined }],
      [MEDIA_SETTINGS, { maxClipSeconds: 180 }],
      [
        SOCIAL_CONNECTION_REPOSITORY,
        new InMemorySocialConnectionRepository(db),
      ],
      [SOCIAL_POST_REPOSITORY, new InMemorySocialPostRepository(db, clock)],
      [SOCIAL_AUDIT_LOG, new InMemorySocialAuditLog(db, clock)],
      [SOCIAL_TOKEN_CIPHER, this.tokenCipher],
      [SOCIAL_OBSERVER, this.socialObserver],
      [
        SOCIAL_SETTINGS,
        {
          webUrl: 'http://web.test',
          redirectUri: (provider: SocialProviderId) =>
            `http://api.test/api/v1/social/oauth/${provider}/callback`,
          mediaUrlTtlSeconds: 3600,
        },
      ],
      [
        SOCIAL_PROVIDER_REGISTRY,
        new SocialProviderRegistry(Object.values(this.social)),
      ],
    ];
    const providers = [
      MetricsService,
      { provide: JOB_OBSERVER, useExisting: MetricsService },
      ...values.map(([provide, useValue]) => ({ provide, useValue })),
    ];

    @Global()
    @Module({
      // In-memory lock store: acceptable only here, never in production wiring.
      imports: [
        LocksModule.forRoot({ isGlobal: true, allowInMemoryStorage: true }),
      ],
      providers,
      exports: [
        MetricsService,
        JOB_OBSERVER,
        ...values.map(([token]) => token),
      ],
    })
    class TestInfrastructureModule {}

    return { module: TestInfrastructureModule };
  }
}
