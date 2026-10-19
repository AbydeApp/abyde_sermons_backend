import { Inject, Injectable } from '@nestjs/common';
import { CHURCH_PROFILE, type ChurchProfilePort } from '../../shared/application/church-profile.js';
import { CACHE, type CachePort } from '../../shared/application/ports/cache.port.js';
import type { Page, PageRequest } from '../../shared/domain/pagination.js';
import { SERMON_QUERY, type SermonQueryPort } from '../sermons/sermons.repository.js';
import { type SermonView } from '../sermons/helper.js';
import { TRANSCRIPT_REPOSITORY, type TranscriptRepositoryPort } from '../sermons/sermons.repository.js';
import { GROUNDED_ANSWER, type GroundedAnswerPort, SEGMENT_SEARCH, type SegmentSearchPort } from './adapters/ports.js';
import { LIBRARY_FACETS, type LibraryFacets, type LibraryFacetsPort } from './library.repository.js';
import {
  ASK_RETRIEVE, type AskAnswer, excerptOf, FACETS_TTL_SECONDS, facetsCacheKey, FALLBACK_SOURCES, hasFilters,
  type LibraryFilters, MIN_EVIDENCE_SIMILARITY, NO_EVIDENCE_ANSWER, rankSermons, SEMANTIC_CANDIDATES,
} from './helper.js';

/** Search and "Ask my ministry" over the church's own READY sermons. */
@Injectable()
export class LibraryService {
  constructor(
    @Inject(SERMON_QUERY) private readonly sermons: SermonQueryPort,
    @Inject(SEGMENT_SEARCH) private readonly segments: SegmentSearchPort,
    @Inject(GROUNDED_ANSWER) private readonly answers: GroundedAnswerPort,
    @Inject(TRANSCRIPT_REPOSITORY) private readonly transcripts: TranscriptRepositoryPort,
    @Inject(LIBRARY_FACETS) private readonly facetsQuery: LibraryFacetsPort,
    @Inject(CHURCH_PROFILE) private readonly profiles: ChurchProfilePort,
    @Inject(CACHE) private readonly cache: CachePort,
  ) {}

  search(churchId: string, filters: LibraryFilters, page: PageRequest): Promise<Page<SermonView>> {
    return this.sermons.list(churchId, { ...filters, statuses: ['READY'] }, page);
  }

  /** Ranks a church's READY sermons by their closest transcript segment to the query meaning. */
  async semanticSearch(churchId: string, query: string, filters: LibraryFilters, page: PageRequest): Promise<Page<SermonView>> {
    const sermonIds = hasFilters(filters)
      ? await this.sermons.matchingIds(churchId, { ...filters, statuses: ['READY'] })
      : undefined;
    const { matches } = await this.segments.search(churchId, query, {
      limit: SEMANTIC_CANDIDATES,
      sermonIds,
      operation: 'library.semantic_search',
    });
    const ranked = rankSermons(matches);
    const start = (page.page - 1) * page.pageSize;
    const items = await this.sermons.findViews(churchId, ranked.slice(start, start + page.pageSize));
    return { items, total: ranked.length, ...page };
  }

  async facets(churchId: string): Promise<LibraryFacets> {
    const key = facetsCacheKey(churchId);
    const cached = await this.cache.get<LibraryFacets>(key);
    if (cached) return cached;
    const facets = await this.facetsQuery.facets(churchId);
    await this.cache.set(key, facets, FACETS_TTL_SECONDS);
    return facets;
  }

  /** RAG over the church's own sermons only. The model must admit when the archive does not answer the question. */
  async ask(churchId: string, question: string): Promise<AskAnswer> {
    const { matches: found } = await this.segments.search(churchId, question, {
      limit: ASK_RETRIEVE,
      operation: 'ask.embed',
    });
    const matches = found.filter((match) => match.similarity >= MIN_EVIDENCE_SIMILARITY);
    if (matches.length === 0) return { answer: NO_EVIDENCE_ANSWER, sources: [] };

    const [segments, sermons] = await Promise.all([
      this.transcripts.findSegments(churchId, matches.map((match) => match.segmentId)),
      this.sermons.findViews(churchId, [...new Set(matches.map((match) => match.sermonId))]),
    ]);
    const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
    const sermonById = new Map(sermons.map((sermon) => [sermon.id, sermon]));
    const evidence = matches.flatMap((match) => {
      const segment = segmentById.get(match.segmentId);
      const sermon = sermonById.get(match.sermonId);
      return segment && sermon ? [{ segment, sermon }] : [];
    });
    if (evidence.length === 0) return { answer: NO_EVIDENCE_ANSWER, sources: [] };

    const profile = await this.profiles.findAIProfile(churchId);
    const result = await this.answers.answer({
      churchId,
      churchName: profile?.name ?? null,
      question,
      excerpts: evidence.map(({ segment, sermon }) => ({
        sermonTitle: sermon.title,
        sermonDate: sermon.sermonDate,
        startTimeMs: segment.startTimeMs,
        text: segment.text,
      })),
    });

    if (!result.sufficientEvidence) return { answer: result.answer, sources: [] };
    const cited = [...new Set(result.citedExcerpts)].flatMap((number) => evidence[number - 1] ?? []);
    const sources = (cited.length > 0 ? cited : evidence.slice(0, FALLBACK_SOURCES)).map(({ segment, sermon }) => ({
      sermonId: sermon.id,
      sermonTitle: sermon.title,
      segmentId: segment.id,
      startTimeMs: segment.startTimeMs,
      endTimeMs: segment.endTimeMs,
      excerpt: excerptOf(segment.text),
    }));
    return { answer: result.answer, sources };
  }
}
