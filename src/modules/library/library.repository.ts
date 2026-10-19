import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/infrastructure/prisma/prisma.service.js';

export interface LibraryFacets {
  speakers: string[];
  series: string[];
  scriptures: string[];
  themes: string[];
  years: string[];
  tags: string[];
}

export const LIBRARY_FACETS = Symbol('LIBRARY_FACETS');

export interface LibraryFacetsPort {
  /** Distinct filter values across the church's READY sermons. */
  facets(churchId: string): Promise<LibraryFacets>;
}

@Injectable()
export class PrismaLibraryFacets implements LibraryFacetsPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async facets(churchId: string): Promise<LibraryFacets> {
    const db = this.prisma.db;
    const values = (rows: Array<{ value: string | null }>) =>
      rows.flatMap((row) => (row.value ? [row.value] : []));
    const [speakers, series, scriptures, themes, tags, years] =
      await Promise.all([
        db.$queryRaw<
          Array<{ value: string }>
        >`SELECT DISTINCT "speaker" AS value FROM "sermons" WHERE "church_id" = ${churchId}::uuid AND "status" = 'READY' ORDER BY 1`,
        db.$queryRaw<
          Array<{ value: string }>
        >`SELECT DISTINCT "series" AS value FROM "sermons" WHERE "church_id" = ${churchId}::uuid AND "status" = 'READY' AND "series" IS NOT NULL ORDER BY 1`,
        db.$queryRaw<
          Array<{ value: string }>
        >`SELECT DISTINCT unnest("scriptures") AS value FROM "sermons" WHERE "church_id" = ${churchId}::uuid AND "status" = 'READY' ORDER BY 1`,
        db.$queryRaw<
          Array<{ value: string }>
        >`SELECT DISTINCT unnest("themes") AS value FROM "sermons" WHERE "church_id" = ${churchId}::uuid AND "status" = 'READY' ORDER BY 1`,
        db.$queryRaw<
          Array<{ value: string }>
        >`SELECT DISTINCT unnest("tags") AS value FROM "sermons" WHERE "church_id" = ${churchId}::uuid AND "status" = 'READY' ORDER BY 1`,
        db.$queryRaw<
          Array<{ value: number }>
        >`SELECT DISTINCT EXTRACT(YEAR FROM "sermon_date" + INTERVAL '1 hour')::int AS value FROM "sermons" WHERE "church_id" = ${churchId}::uuid AND "status" = 'READY' ORDER BY 1 DESC`,
      ]);
    return {
      speakers: values(speakers),
      series: values(series),
      scriptures: values(scriptures),
      themes: values(themes),
      tags: values(tags),
      years: years.map((row) => String(row.value)),
    };
  }
}
