import { Global, Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsService } from './integrations.service.js';
import { PublishingService } from './publishing.service.js';

/**
 * Messaging and email connections, and the background publishing that uses them. Repositories and
 * provider adapters are bound by the composition root.
 */
@Global()
@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService, PublishingService],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
