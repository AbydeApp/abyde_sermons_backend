import type { ContentType } from '../../content/helper.js';
import type { IntegrationProvider } from '../../integrations/domain/integration.js';

/**
 * Where each content type is published automatically. `null` means the calendar is a plan only
 * (e.g. WhatsApp broadcasts and video ideas are shared manually in V1) and the dispatcher leaves it alone.
 */
export const CHANNEL_FOR_TYPE: Record<ContentType, IntegrationProvider | null> =
  {
    DEVOTIONAL: 'META',
    SOCIAL_POST: 'META',
    QUOTE: 'META',
    PRAYER: 'META',
    EMAIL: 'EMAIL',
    BIBLE_STUDY: 'EMAIL',
    WHATSAPP: null,
    VIDEO_IDEA: null,
  };

export const AUTO_PUBLISHED_TYPES = (
  Object.keys(CHANNEL_FOR_TYPE) as ContentType[]
).filter((type) => CHANNEL_FOR_TYPE[type] !== null);

export const PROVIDER_LABELS: Record<IntegrationProvider, string> = {
  META: 'Facebook',
  WHATSAPP: 'WhatsApp',
  EMAIL: 'Mailchimp',
  YOUTUBE: 'YouTube',
};
