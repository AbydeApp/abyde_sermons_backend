import type {
  PublishInput,
  PublishingProviderPort,
  PublishResult,
} from '../../src/modules/publishing/application/ports/out/publishing.ports.js';

/** Records publishes in memory. */
export class FakePublisher implements PublishingProviderPort {
  readonly published: PublishInput[] = [];

  constructor(readonly provider: PublishingProviderPort['provider']) {}

  async publish(input: PublishInput): Promise<PublishResult> {
    this.published.push(input);
    return { ok: true, externalId: `fake-${this.published.length}` };
  }
}
