import type {
  SocialProviderRegistryPort,
  SocialPublishingPort,
} from './ports.js';
import {
  PROVIDER_FOR_PLATFORM,
  SOCIAL_PROVIDERS,
  type SocialPlatform,
  type SocialProviderId,
} from '../helper.js';

/** Resolves the adapter behind a platform (Facebook and Instagram both resolve to Meta). */
export class SocialProviderRegistry implements SocialProviderRegistryPort {
  private readonly byProvider: ReadonlyMap<
    SocialProviderId,
    SocialPublishingPort
  >;

  constructor(adapters: readonly SocialPublishingPort[]) {
    this.byProvider = new Map(
      adapters.map((adapter) => [adapter.provider, adapter]),
    );
    const missing = SOCIAL_PROVIDERS.filter(
      (provider) => !this.byProvider.has(provider),
    );
    if (missing.length > 0)
      throw new Error(`No social adapter for: ${missing.join(', ')}`);
    for (const adapter of adapters)
      for (const platform of adapter.platforms)
        if (PROVIDER_FOR_PLATFORM[platform] !== adapter.provider)
          throw new Error(
            `${adapter.provider} adapter cannot serve ${platform}`,
          );
  }

  forPlatform(platform: SocialPlatform): SocialPublishingPort {
    return this.forProvider(PROVIDER_FOR_PLATFORM[platform]);
  }

  forProvider(provider: SocialProviderId): SocialPublishingPort {
    const adapter = this.byProvider.get(provider);
    if (!adapter) throw new Error(`No social adapter for ${provider}`);
    return adapter;
  }

  all(): readonly SocialPublishingPort[] {
    return SOCIAL_PROVIDERS.map((provider) => this.forProvider(provider));
  }
}
