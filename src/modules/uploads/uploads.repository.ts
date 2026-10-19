import { Inject, Injectable } from '@nestjs/common';
import type { Upload } from '../../generated/prisma/client.js';
import { PrismaService } from '../../shared/infrastructure/prisma/prisma.service.js';
import type { UploadPurpose } from './helper.js';

export const UPLOAD_REPOSITORY = Symbol('UPLOAD_REPOSITORY');

export interface UploadRecord {
  id: string;
  churchId: string;
  objectKey: string;
  purpose: UploadPurpose;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface UploadRepositoryPort {
  create(record: UploadRecord): Promise<void>;
  findByKey(churchId: string, objectKey: string): Promise<UploadRecord | null>;
  /** Marks consumed only if unconsumed; false when another request already used the upload. */
  markConsumed(id: string, at: Date): Promise<boolean>;
  findStaleUnconsumed(olderThan: Date, limit: number): Promise<UploadRecord[]>;
  /** Deletes the record only if it is still unconsumed; false when it was consumed meanwhile. */
  deleteIfUnconsumed(id: string): Promise<boolean>;
}

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
