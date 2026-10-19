import type {
  MediaProcessorPort,
  PreparedMedia,
} from '../../src/modules/sermons/adapters/ports.js';
import type { OAuthConnection, OAuthProviderPort } from '../../src/modules/integrations/adapters/ports.js';
import type { IntegrationProvider } from '../../src/modules/integrations/helper.js';

/** Media processing double: no ffmpeg in unit/e2e tests; reports a 10-minute single chunk. */
export class FakeMediaProcessor implements MediaProcessorPort {
  async prepareForTranscription(inputPath: string): Promise<PreparedMedia> {
    return {
      durationMs: 600_000,
      chunks: [{ path: inputPath, offsetMs: 0, durationMs: 600_000 }],
    };
  }
}

/** OAuth double that "connects" without network calls. */
export class FakeOAuthProvider implements OAuthProviderPort {
  readonly configured = true;

  constructor(readonly provider: IntegrationProvider) {}

  authorizationUrl(input: { state: string; redirectUri: string }): string {
    return `https://auth.example/${this.provider.toLowerCase()}?state=${encodeURIComponent(input.state)}&redirect_uri=${encodeURIComponent(input.redirectUri)}`;
  }

  async exchange(input: { code: string }): Promise<OAuthConnection> {
    return {
      credentials: {
        pageId: 'page-1',
        pageAccessToken: `token-${input.code}`,
        accessToken: `token-${input.code}`,
        apiEndpoint: 'https://mc.example',
        listId: 'list-1',
      },
      externalAccountId: 'acct-1',
      accountLabel: `${this.provider} account`,
      expiresAt: null,
    };
  }
}
