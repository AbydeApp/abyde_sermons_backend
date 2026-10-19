import { readFile, stat } from 'node:fs/promises';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { PermanentJobError } from '../../../shared/application/jobs.js';
import type { DocumentTextExtractorPort } from './ports.js';

const MB = 1024 ** 2;
/**
 * Documents are parsed in memory, so anything beyond these sizes is refused with a clear message
 * instead of risking the worker. (Uploads accept up to 2 GB per the web contract; a sermon
 * manuscript is normally well under 1 MB.)
 */
const MAX_PARSE_BYTES = {
  PDF: 100 * MB,
  DOCX: 100 * MB,
  TEXT: 20 * MB,
} as const;
const TOO_LARGE_MESSAGE =
  'This document is too large to read. Upload the sermon audio or paste the transcript instead.';

/** Extracts plain text from sermon manuscripts (PDF, DOCX, TXT). */
export class DocumentTextExtractor implements DocumentTextExtractorPort {
  async extract(
    filePath: string,
    kind: 'PDF' | 'DOCX' | 'TEXT',
  ): Promise<string> {
    if ((await stat(filePath)).size > MAX_PARSE_BYTES[kind]) {
      throw new PermanentJobError(
        `Document exceeds the ${kind} parse limit`,
        TOO_LARGE_MESSAGE,
      );
    }
    try {
      if (kind === 'TEXT')
        return (await readFile(filePath, 'utf8')).replace(/^﻿/, '');
      if (kind === 'DOCX')
        return (await mammoth.extractRawText({ path: filePath })).value;
      const pdf = await getDocumentProxy(
        new Uint8Array(await readFile(filePath)),
      );
      const { text } = await extractText(pdf, { mergePages: true });
      return text;
    } catch (error) {
      throw new PermanentJobError(
        `Document extraction failed: ${(error as Error).message}`,
        'We could not read the text in this document.',
      );
    }
  }
}
