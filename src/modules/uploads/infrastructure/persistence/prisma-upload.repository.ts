import { Inject, Injectable } from '@nestjs/common';
import type { Upload } from '../../../../generated/prisma/client.js';
import { PrismaService } from '../../../../shared/infrastructure/prisma/prisma.service.js';
import type {
  UploadRecord,
  UploadRepositoryPort,
} from '../../application/ports/out/upload-repository.port.js';

const toRecord = (row: Upload): UploadRecord => ({
  ...row,
  sizeBytes: Number(row.sizeBytes),
});

@Injectable()
export class PrismaUploadRepository implements UploadRepositoryPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(record: UploadRecord): Promise<void> {
    await this.prisma.db.upload.create({
      data: { ...record, sizeBytes: BigInt(record.sizeBytes) },
    });
  }

  async findByKey(
    churchId: string,
    objectKey: string,
  ): Promise<UploadRecord | null> {
    const row = await this.prisma.db.upload.findFirst({
      where: { churchId, objectKey },
    });
    return row ? toRecord(row) : null;
  }

  async markConsumed(id: string, at: Date): Promise<boolean> {
    const result = await this.prisma.db.upload.updateMany({
      where: { id, consumedAt: null },
      data: { consumedAt: at },
    });
    return result.count === 1;
  }

  async findStaleUnconsumed(
    olderThan: Date,
    limit: number,
  ): Promise<UploadRecord[]> {
    const rows = await this.prisma.db.upload.findMany({
      where: { consumedAt: null, createdAt: { lt: olderThan } },
      take: limit,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toRecord);
  }

  async deleteIfUnconsumed(id: string): Promise<boolean> {
    const result = await this.prisma.db.upload.deleteMany({
      where: { id, consumedAt: null },
    });
    return result.count === 1;
  }
}
