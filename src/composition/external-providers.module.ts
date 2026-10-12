import { Global, Logger, Module } from '@nestjs/common';
import { EMAIL_SENDER } from '../shared/application/ports/email.port.js';
import { LANGUAGE_MODEL } from '../shared/application/ports/language-model.port.js';
import { STORAGE } from '../shared/application/ports/storage.port.js';
import {
  AI_USAGE_RECORDER,
  type AIUsageRecorderPort,
  USAGE_METER,
  type UsageMeterPort,
} from '../shared/application/ports/usage-meter.port.js';
import { FakeLanguageModel } from '../shared/infrastructure/ai/fake-language-model.js';
import { MeteredLanguageModel } from '../shared/infrastructure/ai/metered-language-model.js';
import { OpenAILanguageModelAdapter } from '../shared/infrastructure/ai/openai-language-model.adapter.js';
import { APP_CONFIG } from '../shared/infrastructure/config/config.module.js';
import type { AppConfig } from '../shared/infrastructure/config/env.schema.js';
import { OutboxEmailAdapter } from '../shared/infrastructure/email/outbox-email.adapter.js';
import { ResendEmailAdapter } from '../shared/infrastructure/email/resend-email.adapter.js';
import { MetricsService } from '../shared/infrastructure/observability/metrics.service.js';
import { S3StorageAdapter } from '../shared/infrastructure/storage/s3-storage.adapter.js';
import {
  BILLING_SETTINGS,
  PAYMENT_PROVIDER,
} from '../modules/billing/application/ports/out/billing.ports.js';
import { FakePaymentAdapter } from '../modules/billing/infrastructure/providers/fake-payment.adapter.js';
import { PaystackAdapter } from '../modules/billing/infrastructure/providers/paystack.adapter.js';
import {
  INTEGRATION_SETTINGS,
  OAUTH_PROVIDERS,
} from '../modules/integrations/application/ports/out/integration.ports.js';
import {
  MailchimpOAuthProvider,
  MetaOAuthProvider,
  WhatsAppOAuthProvider,
  YouTubeOAuthProvider,
} from '../modules/integrations/infrastructure/oauth/oauth-providers.js';
import {
  GROUNDED_ANSWER,
  SEGMENT_SEARCH,
} from '../modules/library/application/ports/out/segment-search.port.js';
import { AIGroundedAnswerAdapter } from '../modules/library/infrastructure/ai-grounded-answer.adapter.js';
import { EmbeddingSegmentSearchAdapter } from '../modules/library/infrastructure/embedding-segment-search.adapter.js';
import { PUBLISHING_PROVIDERS } from '../modules/publishing/application/ports/out/publishing.ports.js';
import {
  MailchimpPublisher,
  MetaPagePublisher,
} from '../modules/publishing/infrastructure/providers/publishing-providers.js';
import {
  DOCUMENT_TEXT_EXTRACTOR,
  MEDIA_PROCESSOR,
  SCRATCH_SPACE,
  TRANSCRIPTION,
} from '../modules/sermons/application/ports/out/processing.ports.js';
import { DocumentTextExtractor } from '../modules/sermons/infrastructure/documents/document-text-extractor.js';
import { FfmpegMediaProcessor } from '../modules/sermons/infrastructure/media/ffmpeg-media-processor.js';
import { OsScratchSpace } from '../modules/sermons/infrastructure/media/os-scratch-space.js';
import { FakeTranscriptionAdapter } from '../modules/sermons/infrastructure/transcription/fake-transcription.adapter.js';
import { OpenAITranscriptionAdapter } from '../modules/sermons/infrastructure/transcription/openai-transcription.adapter.js';

import {
  BRAND_RENDERER,
  MEDIA_OBSERVER,
  MEDIA_SETTINGS,
} from '../modules/brand/application/ports/out/brand.ports.js';
import { MediaMetrics } from '../modules/brand/infrastructure/media-metrics.js';
import { MediaRenderer } from '../modules/brand/infrastructure/rendering/media-renderer.js';
import { SOCIAL_PROVIDER_REGISTRY } from '../modules/social/application/ports/out/social-publishing.port.js';
import {
  SOCIAL_OBSERVER,
  SOCIAL_SETTINGS,
  SOCIAL_TOKEN_CIPHER,
  type SocialObserverPort,
} from '../modules/social/application/ports/out/social-support.ports.js';
import type { SocialProviderId } from '../modules/social/domain/social-platform.js';
import { LinkedInSocialAdapter } from '../modules/social/infrastructure/providers/linkedin/linkedin-social.adapter.js';
import { MetaSocialAdapter } from '../modules/social/infrastructure/providers/meta/meta-social.adapter.js';
import { MediaFiles } from '../modules/social/infrastructure/providers/shared/media-download.js';
import { TikTokSocialAdapter } from '../modules/social/infrastructure/providers/tiktok/tiktok-social.adapter.js';
import { XSocialAdapter } from '../modules/social/infrastructure/providers/x/x-social.adapter.js';
import { YouTubeSocialAdapter } from '../modules/social/infrastructure/providers/youtube/youtube-social.adapter.js';
import { SocialMetrics } from '../modules/social/infrastructure/social-metrics.js';
import { SocialProviderRegistry } from '../modules/social/infrastructure/social-provider.registry.js';
import { AesGcmTokenCipher } from '../shared/infrastructure/crypto/aes-gcm-token-cipher.js';
import {
  REEL_OBSERVER,
  REEL_RENDERER,
  REEL_SETTINGS,
  SPEAKER_TRACKER,
} from '../modules/reels/application/ports/out/reel.ports.js';
import { ReelMetrics } from '../modules/reels/infrastructure/reel-metrics.js';
import { FfmpegReelRenderer } from '../modules/reels/infrastructure/rendering/ffmpeg-reel-renderer.js';
import { CenterSpeakerTracker } from '../modules/reels/infrastructure/tracking/center-speaker-tracker.js';
import { CommandSpeakerTracker } from '../modules/reels/infrastructure/tracking/command-speaker-tracker.js';
import type { StoragePort } from '../shared/application/ports/storage.port.js';
import type { ScratchSpacePort } from '../modules/sermons/application/ports/out/processing.ports.js';
import { createHash } from 'node:crypto';

const DEV_SOCIAL_KEY_SEED = 'abyde-sermon-social-development-only-key';

/** Chooses an adapter per external capability from configuration. Swapping a vendor happens only here. */
@Global()
@Module({
  providers: [
    {
      provide: STORAGE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new S3StorageAdapter(config),
    },
    {
      provide: EMAIL_SENDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        config.EMAIL_PROVIDER === 'resend'
          ? new ResendEmailAdapter(config)
          : new OutboxEmailAdapter(config),
    },
    {
      provide: LANGUAGE_MODEL,
      inject: [APP_CONFIG, AI_USAGE_RECORDER, USAGE_METER, MetricsService],
      useFactory: (
        config: AppConfig,
        recorder: AIUsageRecorderPort,
        meter: UsageMeterPort,
        metrics: MetricsService,
      ) => {
        const openai = config.AI_PROVIDER === 'openai';
        return new MeteredLanguageModel(
          openai
            ? new OpenAILanguageModelAdapter(config)
            : new FakeLanguageModel(),
          openai ? 'openai' : 'fake',
          { text: config.AI_TEXT_MODEL, embedding: config.AI_EMBEDDING_MODEL },
          {
            textInputPerMTok: config.AI_TEXT_INPUT_COST_PER_MTOK,
            textOutputPerMTok: config.AI_TEXT_OUTPUT_COST_PER_MTOK,
            embeddingPerMTok: config.AI_EMBEDDING_COST_PER_MTOK,
          },
          recorder,
          meter,
          metrics,
        );
      },
    },
    {
      provide: TRANSCRIPTION,
      inject: [APP_CONFIG, AI_USAGE_RECORDER],
      useFactory: (config: AppConfig, recorder: AIUsageRecorderPort) =>
        config.TRANSCRIPTION_PROVIDER === 'openai'
          ? new OpenAITranscriptionAdapter(
              {
                apiKey: config.AI_OPENAI_API_KEY ?? '',
                baseUrl: config.AI_OPENAI_BASE_URL,
                model: config.TRANSCRIPTION_MODEL,
              },
              {
                record: (entry) =>
                  recorder.record({
                    churchId: entry.churchId,
                    sermonId: entry.sermonId,
                    operation: 'sermon.transcribe',
                    provider: entry.provider,
                    model: entry.model,
                    inputTokens: 0,
                    outputTokens: 0,
                    estimatedCost:
                      (entry.durationMs / 60_000) *
                      config.TRANSCRIPTION_COST_PER_MINUTE,
                    latencyMs: entry.latencyMs,
                    status: entry.ok ? 'SUCCEEDED' : 'FAILED',
                  }),
              },
            )
          : new FakeTranscriptionAdapter(),
    },
    {
      provide: MEDIA_PROCESSOR,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new FfmpegMediaProcessor(
          config.TRANSCRIPTION_FFMPEG_PATH,
          config.TRANSCRIPTION_FFPROBE_PATH,
        ),
    },
    { provide: DOCUMENT_TEXT_EXTRACTOR, useClass: DocumentTextExtractor },
    { provide: SEGMENT_SEARCH, useClass: EmbeddingSegmentSearchAdapter },
    { provide: GROUNDED_ANSWER, useClass: AIGroundedAnswerAdapter },
    {
      provide: SCRATCH_SPACE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new OsScratchSpace(config.WORKER_TMP_DIR),
    },
    {
      provide: PAYMENT_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        config.BILLING_PROVIDER === 'paystack'
          ? new PaystackAdapter(config.BILLING_PAYSTACK_SECRET_KEY ?? '', {
              starter: config.BILLING_PAYSTACK_PLAN_STARTER,
              growth: config.BILLING_PAYSTACK_PLAN_GROWTH,
              ministry: config.BILLING_PAYSTACK_PLAN_MINISTRY,
            })
          : new FakePaymentAdapter(config.APP_WEB_URL),
    },
    {
      provide: BILLING_SETTINGS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({ webUrl: config.APP_WEB_URL }),
    },
    {
      provide: INTEGRATION_SETTINGS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        webUrl: config.APP_WEB_URL,
        publicApiUrl: config.APP_PUBLIC_API_URL,
      }),
    },
    {
      provide: OAUTH_PROVIDERS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        const meta = {
          appId: config.PUBLISHING_META_APP_ID,
          appSecret: config.PUBLISHING_META_APP_SECRET,
          graphVersion: config.PUBLISHING_META_GRAPH_VERSION,
        };
        return [
          new MetaOAuthProvider(meta),
          new WhatsAppOAuthProvider(meta),
          new MailchimpOAuthProvider({
            clientId: config.PUBLISHING_MAILCHIMP_CLIENT_ID,
            clientSecret: config.PUBLISHING_MAILCHIMP_CLIENT_SECRET,
          }),
          new YouTubeOAuthProvider({
            clientId: config.PUBLISHING_GOOGLE_CLIENT_ID,
            clientSecret: config.PUBLISHING_GOOGLE_CLIENT_SECRET,
          }),
        ];
      },
    },
    {
      provide: PUBLISHING_PROVIDERS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => [
        new MetaPagePublisher(config.PUBLISHING_META_GRAPH_VERSION),
        new MailchimpPublisher(),
      ],
    },
    { provide: MEDIA_OBSERVER, useClass: MediaMetrics },
    {
      provide: MEDIA_SETTINGS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        maxClipSeconds: config.MEDIA_MAX_CLIP_SECONDS,
      }),
    },
    {
      provide: BRAND_RENDERER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new MediaRenderer(config.MEDIA_FFMPEG_PATH, config.MEDIA_FFPROBE_PATH),
    },
    { provide: REEL_OBSERVER, useClass: ReelMetrics },
    {
      provide: REEL_SETTINGS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        minSeconds: config.MEDIA_REEL_MIN_SECONDS,
        maxSeconds: config.MEDIA_REEL_MAX_SECONDS,
        hookSeconds: config.MEDIA_REEL_HOOK_SECONDS,
        outroSeconds: config.MEDIA_REEL_OUTRO_SECONDS,
      }),
    },
    {
      provide: REEL_RENDERER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new FfmpegReelRenderer(
          config.MEDIA_FFMPEG_PATH,
          config.MEDIA_FFPROBE_PATH,
        ),
    },
    {
      provide: SPEAKER_TRACKER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        config.MEDIA_SPEAKER_TRACKER === 'command' &&
        config.MEDIA_SPEAKER_TRACKER_COMMAND
          ? new CommandSpeakerTracker({
              command: config.MEDIA_SPEAKER_TRACKER_COMMAND,
              timeoutMs: config.MEDIA_SPEAKER_TRACKER_TIMEOUT_MS,
              sampleFps: config.MEDIA_SPEAKER_TRACKER_FPS,
            })
          : new CenterSpeakerTracker(),
    },
    { provide: SOCIAL_OBSERVER, useClass: SocialMetrics },
    {
      provide: SOCIAL_TOKEN_CIPHER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        if (config.SOCIAL_TOKEN_ENCRYPTION_KEY)
          return new AesGcmTokenCipher(
            config.SOCIAL_TOKEN_ENCRYPTION_KEY,
            config.SOCIAL_TOKEN_ENCRYPTION_KEYS_PREVIOUS,
          );
        // Staging and production refuse to boot without a key once a provider is configured.
        new Logger('SocialTokenCipher').warn(
          'SOCIAL_TOKEN_ENCRYPTION_KEY not set; using a development-only key',
        );
        return new AesGcmTokenCipher(
          createHash('sha256').update(DEV_SOCIAL_KEY_SEED).digest('base64'),
        );
      },
    },
    {
      provide: SOCIAL_SETTINGS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        webUrl: config.APP_WEB_URL,
        redirectUri: (provider: SocialProviderId) =>
          `${config.APP_PUBLIC_API_URL}/social/oauth/${provider}/callback`,
        mediaUrlTtlSeconds: config.SOCIAL_MEDIA_URL_TTL_SECONDS,
      }),
    },
    {
      provide: SOCIAL_PROVIDER_REGISTRY,
      inject: [APP_CONFIG, SOCIAL_OBSERVER, STORAGE, SCRATCH_SPACE],
      useFactory: (
        config: AppConfig,
        observer: SocialObserverPort,
        storage: StoragePort,
        scratch: ScratchSpacePort,
      ) => {
        const timeoutMs = config.SOCIAL_HTTP_TIMEOUT_MS;
        const media = new MediaFiles(storage, scratch);
        return new SocialProviderRegistry([
          new MetaSocialAdapter(
            {
              appId: config.SOCIAL_META_APP_ID,
              appSecret: config.SOCIAL_META_APP_SECRET,
              graphVersion: config.SOCIAL_META_GRAPH_VERSION,
              timeoutMs,
            },
            observer,
          ),
          new TikTokSocialAdapter(
            {
              clientKey: config.SOCIAL_TIKTOK_CLIENT_KEY,
              clientSecret: config.SOCIAL_TIKTOK_CLIENT_SECRET,
              timeoutMs,
              audited: config.SOCIAL_TIKTOK_AUDITED,
            },
            observer,
          ),
          new YouTubeSocialAdapter(
            {
              clientId: config.SOCIAL_GOOGLE_CLIENT_ID,
              clientSecret: config.SOCIAL_GOOGLE_CLIENT_SECRET,
              timeoutMs,
            },
            observer,
            media,
          ),
          new XSocialAdapter(
            {
              clientId: config.SOCIAL_X_CLIENT_ID,
              clientSecret: config.SOCIAL_X_CLIENT_SECRET,
              timeoutMs,
            },
            observer,
            media,
          ),
          new LinkedInSocialAdapter(
            {
              clientId: config.SOCIAL_LINKEDIN_CLIENT_ID,
              clientSecret: config.SOCIAL_LINKEDIN_CLIENT_SECRET,
              timeoutMs,
              apiVersion: config.SOCIAL_LINKEDIN_API_VERSION,
              organizations: config.SOCIAL_LINKEDIN_ORGANIZATIONS,
            },
            observer,
            media,
          ),
        ]);
      },
    },
  ],
  exports: [
    REEL_OBSERVER,
    REEL_SETTINGS,
    REEL_RENDERER,
    SPEAKER_TRACKER,
    MEDIA_OBSERVER,
    MEDIA_SETTINGS,
    BRAND_RENDERER,
    SOCIAL_OBSERVER,
    SOCIAL_TOKEN_CIPHER,
    SOCIAL_SETTINGS,
    SOCIAL_PROVIDER_REGISTRY,
    STORAGE,
    EMAIL_SENDER,
    LANGUAGE_MODEL,
    TRANSCRIPTION,
    MEDIA_PROCESSOR,
    DOCUMENT_TEXT_EXTRACTOR,
    SEGMENT_SEARCH,
    GROUNDED_ANSWER,
    SCRATCH_SPACE,
    PAYMENT_PROVIDER,
    BILLING_SETTINGS,
    INTEGRATION_SETTINGS,
    OAUTH_PROVIDERS,
    PUBLISHING_PROVIDERS,
  ],
})
export class ExternalProvidersModule {}
