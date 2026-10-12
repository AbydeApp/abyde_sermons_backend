import { Inject, Injectable } from '@nestjs/common';
import type { Church as ChurchRow } from '../../../../generated/prisma/client.js';
import {
  isUniqueViolation,
  PrismaService,
} from '../../../../shared/infrastructure/prisma/prisma.service.js';
import { Church } from '../../domain/church.entity.js';
import type { ChurchRepositoryPort } from '../../application/ports/out/church-repository.port.js';
import { churchExists } from '../../application/use-cases/church.use-cases.js';

const toChurch = ({
  createdAt: _c,
  updatedAt: _u,
  ...row
}: ChurchRow): Church => Church.restore(row);

@Injectable()
export class PrismaChurchRepository implements ChurchRepositoryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Church | null> {
    const row = await this.prisma.db.church.findUnique({ where: { id } });
    return row ? toChurch(row) : null;
  }

  async findByUserId(userId: string): Promise<Church | null> {
    const row = await this.prisma.db.church.findUnique({ where: { userId } });
    return row ? toChurch(row) : null;
  }

  async findIdByUserId(userId: string): Promise<string | null> {
    const row = await this.prisma.db.church.findUnique({
      where: { userId },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  async slugExists(slug: string): Promise<boolean> {
    return (await this.prisma.db.church.count({ where: { slug } })) > 0;
  }

  async save(church: Church): Promise<void> {
    const { id, userId, ...data } = church.snapshot();
    try {
      await this.prisma.db.church.upsert({
        where: { id },
        create: { id, userId, ...data },
        update: data,
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw churchExists();
      throw error;
    }
  }
}
