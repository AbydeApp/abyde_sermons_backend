export type SermonStatus =
  | 'UPLOADING'
  | 'UPLOADED'
  | 'QUEUED'
  | 'TRANSCRIBING'
  | 'ANALYZING'
  | 'INDEXING'
  | 'READY'
  | 'FAILED'
  | 'ARCHIVED';

/** The seven steps the web app renders, in order. */
export const PROCESSING_STAGES = [
  'UPLOAD',
  'MEDIA',
  'TRANSCRIBE',
  'UNDERSTAND',
  'SCRIPTURES',
  'INTELLIGENCE',
  'INDEX',
] as const;
export type ProcessingStage = (typeof PROCESSING_STAGES)[number];

export const PROCESSING_STATUSES: SermonStatus[] = [
  'UPLOADING',
  'UPLOADED',
  'QUEUED',
  'TRANSCRIBING',
  'ANALYZING',
  'INDEXING',
];

const STATUS_FOR_STAGE: Record<ProcessingStage, SermonStatus> = {
  UPLOAD: 'QUEUED',
  MEDIA: 'TRANSCRIBING',
  TRANSCRIBE: 'TRANSCRIBING',
  UNDERSTAND: 'ANALYZING',
  SCRIPTURES: 'ANALYZING',
  INTELLIGENCE: 'ANALYZING',
  INDEX: 'INDEXING',
};

export const statusForStage = (stage: ProcessingStage): SermonStatus =>
  STATUS_FOR_STAGE[stage];

/** Pipeline phases map onto queues: each phase is retried independently. */
export type PipelinePhase = 'TRANSCRIPTION' | 'ANALYSIS' | 'INDEXING';

export function phaseForStage(stage: ProcessingStage): PipelinePhase {
  if (stage === 'UPLOAD' || stage === 'MEDIA' || stage === 'TRANSCRIBE')
    return 'TRANSCRIPTION';
  if (stage === 'INDEX') return 'INDEXING';
  return 'ANALYSIS';
}

/** User-safe failure messages per stage (provider errors are never shown). */
export const STAGE_FAILURE_MESSAGES: Record<ProcessingStage, string> = {
  UPLOAD: 'We could not start processing this upload.',
  MEDIA:
    'We could not read this file. Check that it plays correctly and try again.',
  TRANSCRIBE: 'We could not transcribe this sermon. Please try again.',
  UNDERSTAND: 'We could not analyse this sermon. Please try again.',
  SCRIPTURES: 'We could not check the scripture references. Please try again.',
  INTELLIGENCE: 'We could not build the sermon summary. Please try again.',
  INDEX: 'We could not prepare this sermon for search. Please try again.',
};

export type SermonSourceType = 'MEDIA' | 'DOCUMENT' | 'TEXT';
