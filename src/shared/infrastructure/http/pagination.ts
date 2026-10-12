import { z } from 'zod';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type Page,
  type PageRequest,
} from '../../domain/pagination.js';

export const pageQuery = {
  page: z.coerce.number().int().min(1, 'Page must be at least 1').default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE, `Page size must be at most ${MAX_PAGE_SIZE}`)
    .default(DEFAULT_PAGE_SIZE),
};

export interface PaginatedResponse<T> {
  data: T[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

export function toPaginated<T, R>(
  page: Page<T>,
  map: (item: T) => R,
): PaginatedResponse<R> {
  return {
    data: page.items.map(map),
    meta: {
      page: page.page,
      pageSize: page.pageSize,
      total: page.total,
      totalPages: Math.ceil(page.total / page.pageSize),
    },
  };
}

export const pageRequest = (query: {
  page: number;
  pageSize: number;
}): PageRequest => ({ page: query.page, pageSize: query.pageSize });

export const uuidParam = z.string().uuid('Invalid id');
