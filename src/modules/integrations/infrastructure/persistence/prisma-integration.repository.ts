import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/infrastructure/prisma/prisma.service.js';
import type {
  IntegrationProvider,
  IntegrationRecord,
} from '../../domain/integration.js';
import type { IntegrationRepositoryPort } from '../../application/ports/out/integration.ports.js';

const SELECT = {
  id: true,
  churchId: true,
  provider: true,
  status: true,
  encryptedCredentials: true,
  externalAccountId: true,
  accountLabel: true,
  expiresAt: true,
} as const;

@Injectable()
export class PrismaIntegrationRepository implements IntegrationRepositoryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  list(churchId: string): Promise<IntegrationRecord[]> {
    return this.prisma.db.integration.findMany({
      where: { churchId },
      select: SELECT,
    });
  }

  find(
    churchId: string,
    provider: IntegrationProvider,
  ): Promise<IntegrationRecord | null> {
    return this.prisma.db.integration.findUnique({
      where: { churchId_provider: { churchId, provider } },
      select: SELECT,
    });
  }

  async upsert(record: IntegrationRecord): Promise<void> {
    const { id, churchId, provider, ...data } = record;
    await this.prisma.db.integration.upsert({
      where: { churchId_provider: { churchId, provider } },
      create: { id, churchId, provider, ...data },
      update: data,
    });
  }

  async setStatus(
    churchId: string,
    provider: IntegrationProvider,
    status: IntegrationRecord['status'],
  ): Promise<void> {
    await this.prisma.db.integration.updateMany({
      where: { churchId, provider },
      data: { status },
    });
  }

  async delete(churchId: string, provider: IntegrationProvider): Promise<void> {
    await this.prisma.db.integration.deleteMany({
      where: { churchId, provider },
    });
  }
}
