import { Inject, Injectable } from '@nestjs/common';
import {
  CACHE,
  type CachePort,
} from '../../../../shared/application/ports/cache.port.js';
import type {
  Page,
  PageRequest,
} from '../../../../shared/domain/pagination.js';
import {
  SERMON_QUERY,
  type SermonFilter,
  type SermonQueryPort,
  type SermonView,
} from '../../../sermons/application/ports/out/sermon-repository.port.js';
import {
  SEGMENT_SEARCH,
  type SegmentSearchPort,
} from '../ports/out/segment-search.port.js';
import {
  LIBRARY_FACETS,
  type LibraryFacets,
  type LibraryFacetsPort,
} from '../ports/out/library-facets.port.js';

export type LibraryFilters = Pick<
  SermonFilter,
  'speaker' | 'series' | 'scripture' | 'theme' | 'tag' | 'year'
>;

const hasFilters = (filters: LibraryFilters) =>
  Object.values(filters).some((value) => value !== undefined && value !== '');

@Injectable()
export class SearchLibraryUseCase {
  constructor(
    @Inject(SERMON_QUERY) private readonly sermons: SermonQueryPort,
  ) {}

  execute(
    churchId: string,
    filters: LibraryFilters,
    page: PageRequest,
  ): Promise<Page<SermonView>> {
    return this.sermons.list(
      churchId,
      { ...filters, statuses: ['READY'] },
      page,
    );
  }
}

const SEMANTIC_CANDIDATES = 300;
const MIN_SIMILARITY = 0.2;

@Injectable()
export class SemanticSearchUseCase {
  constructor(
    @Inject(SERMON_QUERY) private readonly sermons: SermonQueryPort,
    @Inject(SEGMENT_SEARCH) private readonly segments: SegmentSearchPort,
  ) {}

  /** Ranks a church's READY sermons by their closest transcript segment to the query meaning. */
  async execute(
    churchId: string,
    query: string,
    filters: LibraryFilters,
    page: PageRequest,
  ): Promise<Page<SermonView>> {
    const sermonIds = hasFilters(filters)
      ? await this.sermons.matchingIds(churchId, {
          ...filters,
          statuses: ['READY'],
        })
      : undefined;
    const { matches } = await this.segments.search(churchId, query, {
      limit: SEMANTIC_CANDIDATES,
      sermonIds,
      operation: 'library.semantic_search',
    });
    const best = new Map<string, number>();
    for (const match of matches) {
      if (match.similarity < MIN_SIMILARITY) continue;
      best.set(
        match.sermonId,
        Math.max(best.get(match.sermonId) ?? -1, match.similarity),
      );
    }
    const ranked = [...best.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
    const start = (page.page - 1) * page.pageSize;
    const items = await this.sermons.findViews(
      churchId,
      ranked.slice(start, start + page.pageSize),
    );
    return { items, total: ranked.length, ...page };
  }
}

@Injectable()
export class GetLibraryFacetsUseCase {
  constructor(
    @Inject(LIBRARY_FACETS) private readonly facets: LibraryFacetsPort,
    @Inject(CACHE) private readonly cache: CachePort,
  ) {}

  async execute(churchId: string): Promise<LibraryFacets> {
    const key = `library-facets:${churchId}`;
    const cached = await this.cache.get<LibraryFacets>(key);
    if (cached) return cached;
    const facets = await this.facets.facets(churchId);
    await this.cache.set(key, facets, 60); // short TTL: new sermons appear within a minute
    return facets;
  }
}
