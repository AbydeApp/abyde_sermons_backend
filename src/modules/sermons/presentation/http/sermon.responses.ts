import type { SermonView } from '../../application/ports/out/sermon-repository.port.js';
import type {
  SermonIntelligence,
  TranscriptSegmentRecord,
} from '../../domain/sermon-intelligence.js';

export interface SermonResponse extends Omit<
  SermonView,
  'sermonDate' | 'createdAt'
> {
  sermonDate: string;
  createdAt: string;
}

export const toSermonResponse = (view: SermonView): SermonResponse => ({
  ...view,
  sermonDate: view.sermonDate.toISOString(),
  createdAt: view.createdAt.toISOString(),
});

export const toSegmentResponse = (segment: TranscriptSegmentRecord) => ({
  id: segment.id,
  sequence: segment.sequence,
  startTimeMs: segment.startTimeMs,
  endTimeMs: segment.endTimeMs,
  text: segment.text,
  speakerLabel: segment.speakerLabel,
});

type IntelligenceItemResponse = {
  id: string;
  text: string;
  sourceSegmentId?: string;
};

const item = (entry: {
  id: string;
  text: string;
  sourceSegmentId: string | null;
}): IntelligenceItemResponse =>
  entry.sourceSegmentId
    ? { id: entry.id, text: entry.text, sourceSegmentId: entry.sourceSegmentId }
    : { id: entry.id, text: entry.text };

/** Web contract: themes = main theme first, then secondary themes. */
export const toIntelligenceResponse = (data: SermonIntelligence) => ({
  themes: [data.mainTheme, ...data.secondaryThemes].map(item),
  keyPoints: data.keyPoints.map(item),
  quotes: data.quotes.map(item),
  stories: data.stories.map(item),
  applications: data.applications.map(item),
  prayers: data.prayers.map(item),
  questions: data.questions.map(item),
});
