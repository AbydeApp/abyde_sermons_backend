import { Inject, Injectable } from '@nestjs/common';
import {
  GROUNDED_ANSWER,
  type GroundedAnswerPort,
  SEGMENT_SEARCH,
  type SegmentSearchPort,
} from '../ports/out/segment-search.port.js';
import {
  CHURCH_PROFILE,
  type ChurchProfilePort,
} from '../../../../shared/application/church-profile.js';
import {
  SERMON_QUERY,
  type SermonQueryPort,
} from '../../../sermons/application/ports/out/sermon-repository.port.js';
import {
  TRANSCRIPT_REPOSITORY,
  type TranscriptRepositoryPort,
} from '../../../sermons/application/ports/out/transcript-repository.port.js';

export interface AskSource {
  sermonId: string;
  sermonTitle: string;
  segmentId: string;
  startTimeMs: number;
  endTimeMs: number;
  excerpt: string;
}

export interface AskAnswer {
  answer: string;
  sources: AskSource[];
}

const RETRIEVE = 12;
const MIN_EVIDENCE_SIMILARITY = 0.25;
const EXCERPT_CHARS = 320;
export const NO_EVIDENCE_ANSWER =
  "I couldn't find anything in your sermon archive that addresses this question, so I can't say what your church has taught about it.";

/** RAG over the church's own sermons only. The model must admit when the archive does not answer the question. */
@Injectable()
export class AskMinistryUseCase {
  constructor(
    @Inject(SEGMENT_SEARCH) private readonly segments: SegmentSearchPort,
    @Inject(GROUNDED_ANSWER) private readonly answers: GroundedAnswerPort,
    @Inject(TRANSCRIPT_REPOSITORY)
    private readonly transcripts: TranscriptRepositoryPort,
    @Inject(SERMON_QUERY) private readonly sermons: SermonQueryPort,
    @Inject(CHURCH_PROFILE) private readonly profiles: ChurchProfilePort,
  ) {}

  async execute(churchId: string, question: string): Promise<AskAnswer> {
    const { matches: found } = await this.segments.search(churchId, question, {
      limit: RETRIEVE,
      operation: 'ask.embed',
    });
    const matches = found.filter(
      (match) => match.similarity >= MIN_EVIDENCE_SIMILARITY,
    );
    if (matches.length === 0)
      return { answer: NO_EVIDENCE_ANSWER, sources: [] };

    const [segments, sermons] = await Promise.all([
      this.transcripts.findSegments(
        churchId,
        matches.map((match) => match.segmentId),
      ),
      this.sermons.findViews(churchId, [
        ...new Set(matches.map((match) => match.sermonId)),
      ]),
    ]);
    const segmentById = new Map(
      segments.map((segment) => [segment.id, segment]),
    );
    const sermonById = new Map(sermons.map((sermon) => [sermon.id, sermon]));
    const evidence = matches.flatMap((match) => {
      const segment = segmentById.get(match.segmentId);
      const sermon = sermonById.get(match.sermonId);
      return segment && sermon ? [{ segment, sermon }] : [];
    });
    if (evidence.length === 0)
      return { answer: NO_EVIDENCE_ANSWER, sources: [] };

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

    if (!result.sufficientEvidence)
      return { answer: result.answer, sources: [] };
    const cited = [...new Set(result.citedExcerpts)].flatMap(
      (number) => evidence[number - 1] ?? [],
    );
    const sources = (cited.length > 0 ? cited : evidence.slice(0, 3)).map(
      ({ segment, sermon }) => ({
        sermonId: sermon.id,
        sermonTitle: sermon.title,
        segmentId: segment.id,
        startTimeMs: segment.startTimeMs,
        endTimeMs: segment.endTimeMs,
        excerpt:
          segment.text.length > EXCERPT_CHARS
            ? `${segment.text.slice(0, EXCERPT_CHARS).trimEnd()}…`
            : segment.text,
      }),
    );
    return { answer: result.answer, sources };
  }
}
