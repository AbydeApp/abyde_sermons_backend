import type { TranscriptFragment } from '../../../domain/transcript-segmenter.js';

export const TRANSCRIPTION = Symbol('TRANSCRIPTION');

export interface TranscriptionResult {
  provider: string;
  language: string | null;
  /** Timed fragments (relative to the file); `words` are word-level timings when supported. */
  fragments: Array<
    Required<Omit<TranscriptFragment, 'words'>> &
      Pick<TranscriptFragment, 'words'>
  >;
}

export interface TranscriptionPort {
  transcribe(input: {
    filePath: string;
    durationMs: number;
    context: { churchId: string; sermonId: string };
    signal?: AbortSignal;
  }): Promise<TranscriptionResult>;
}

export const MEDIA_PROCESSOR = Symbol('MEDIA_PROCESSOR');

export interface PreparedMedia {
  durationMs: number;
  chunks: Array<{ path: string; offsetMs: number; durationMs: number }>;
}

/** Normalises sermon audio/video into small speech-ready chunks (mono, low bitrate) on local disk. */
export interface MediaProcessorPort {
  prepareForTranscription(
    inputPath: string,
    workDir: string,
    signal?: AbortSignal,
  ): Promise<PreparedMedia>;
}

export const DOCUMENT_TEXT_EXTRACTOR = Symbol('DOCUMENT_TEXT_EXTRACTOR');

export interface DocumentTextExtractorPort {
  extract(filePath: string, kind: 'PDF' | 'DOCX' | 'TEXT'): Promise<string>;
}

export const SERMON_QUOTA = Symbol('SERMON_QUOTA');

/** Plan enforcement, implemented by billing. Called inside the sermon-creation lock. */
export interface SermonQuotaPort {
  assertCanCreateSermon(churchId: string): Promise<void>;
}

export const SCRATCH_SPACE = Symbol('SCRATCH_SPACE');

/** Temporary working directory for media processing; always cleaned up. */
export interface ScratchSpacePort {
  withDirectory<T>(fn: (dir: string) => Promise<T>): Promise<T>;
}
