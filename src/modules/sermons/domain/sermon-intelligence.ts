import type { TranscriptWord } from './transcript-segmenter.js';

/** Evidence-linked item extracted from a sermon. `sourceSegmentId` (when set) belongs to the same sermon. */
export interface IntelligenceItem {
  id: string;
  text: string;
  sourceSegmentId: string | null;
  startTimeMs: number | null;
  endTimeMs: number | null;
}

/** Persisted structured representation of a sermon (validated before storage). */
export interface SermonIntelligence {
  title: string;
  summary: string;
  mainTheme: IntelligenceItem;
  secondaryThemes: IntelligenceItem[];
  keyPoints: IntelligenceItem[];
  /** Verbatim pastor quotes only — each verified against its transcript segment. */
  quotes: IntelligenceItem[];
  stories: IntelligenceItem[];
  applications: IntelligenceItem[];
  prayers: IntelligenceItem[];
  questions: IntelligenceItem[];
  audienceTakeaways: IntelligenceItem[];
  /** Verified scripture display strings. */
  scriptures: string[];
}

export interface ScriptureReferenceRecord {
  id: string;
  churchId: string;
  sermonId: string;
  book: string;
  chapter: number;
  verseStart: number | null;
  verseEnd: number | null;
  translation: string | null;
  verified: boolean;
  display: string;
  sourceSegmentId: string | null;
}

export interface TranscriptSegmentRecord {
  id: string;
  sequence: number;
  startTimeMs: number;
  endTimeMs: number;
  text: string;
  speakerLabel: string | null;
  /** Word-level timings (absolute, ms) when transcription provided them. */
  words?: TranscriptWord[];
}
