import { Global, Module } from '@nestjs/common';
import {
  CompleteOAuthUseCase,
  ConnectIntegrationUseCase,
  DisconnectIntegrationUseCase,
  IntegrationCredentialsService,
  ListIntegrationsUseCase,
} from './application/use-cases/integration.use-cases.js';
import { IntegrationsController } from './presentation/http/integrations.controller.js';

@Global()
@Module({
  controllers: [IntegrationsController],
  providers: [
    ListIntegrationsUseCase,
    ConnectIntegrationUseCase,
    CompleteOAuthUseCase,
    DisconnectIntegrationUseCase,
    IntegrationCredentialsService,
  ],
  exports: [IntegrationCredentialsService],
})
export class IntegrationsModule {}
