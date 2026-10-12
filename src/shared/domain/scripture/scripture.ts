import { BIBLE_BOOKS, type BibleBook } from './bible-books.js';

export interface ScriptureRef {
  book: string;
  chapter: number;
  verseStart: number | null;
  verseEnd: number | null;
}

export type VerificationResult =
  { valid: true } | { valid: false; reason: string };

const ORDINALS: Array<[RegExp, string]> = [
  [/^(first|1st|i)\s+/, '1 '],
  [/^(second|2nd|ii)\s+/, '2 '],
  [/^(third|3rd|iii)\s+/, '3 '],
];

function normalizeKey(raw: string): string {
  let key = raw
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/^(\d)\s*(?=[a-z])/, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [pattern, replacement] of ORDINALS)
    key = key.replace(pattern, replacement);
  return key
    .replace(/^the /, '')
    .replace(/^(book of|gospel of|gospel according to) /, '');
}

const BOOK_INDEX = new Map<string, BibleBook>();
for (const book of BIBLE_BOOKS) {
  for (const key of [book.name, ...book.aliases])
    BOOK_INDEX.set(normalizeKey(key), book);
}

export function findBook(raw: string): BibleBook | null {
  return BOOK_INDEX.get(normalizeKey(raw)) ?? null;
}

/** Bounds check against canonical chapter/verse counts. Never trusts a model's claim that a verse exists. */
export function verifyReference(ref: ScriptureRef): VerificationResult {
  const book = findBook(ref.book);
  if (!book) return { valid: false, reason: 'unknown book' };
  const verseCount = book.verses[ref.chapter - 1];
  if (
    !Number.isInteger(ref.chapter) ||
    ref.chapter < 1 ||
    verseCount === undefined
  ) {
    return {
      valid: false,
      reason: `${book.name} has ${book.verses.length} chapters`,
    };
  }
  if (ref.verseStart !== null) {
    if (ref.verseStart < 1 || ref.verseStart > verseCount) {
      return {
        valid: false,
        reason: `${book.name} ${ref.chapter} has ${verseCount} verses`,
      };
    }
    if (
      ref.verseEnd !== null &&
      (ref.verseEnd < ref.verseStart || ref.verseEnd > verseCount)
    ) {
      return { valid: false, reason: `invalid verse range` };
    }
  } else if (ref.verseEnd !== null) {
    return { valid: false, reason: 'verse range without a start verse' };
  }
  return { valid: true };
}

export function formatReference(ref: ScriptureRef): string {
  const book = findBook(ref.book);
  const name = book?.name === 'Psalms' ? 'Psalm' : (book?.name ?? ref.book);
  if (ref.verseStart === null) return `${name} ${ref.chapter}`;
  const range =
    ref.verseEnd !== null && ref.verseEnd !== ref.verseStart
      ? `-${ref.verseEnd}`
      : '';
  return `${name} ${ref.chapter}:${ref.verseStart}${range}`;
}

const NUMBER = '(\\d{1,3})';
const RANGE_SEPARATOR = '\\s*(?:-|\u2013|\u2014|to|through|thru)\\s*';
// "3:16-18", "3:16", "3", "chapter 3 verse 16 to 18", "3 verses 16-18"
const LOCATION = `(?:chapter\\s+)?${NUMBER}(?:\\s*(?::|\\s+verses?\\s+|,\\s*verses?\\s+)${NUMBER}(?:${RANGE_SEPARATOR}(?:verse\\s+)?${NUMBER})?)?`;

/** Parses a single reference such as "John 3:16-18", "1 Cor 13", "First John chapter 4 verse 8". */
export function parseReference(text: string): ScriptureRef | null {
  const match = new RegExp(
    `^\\s*((?:[1-3]|i{1,3}|first|second|third|1st|2nd|3rd)?\\s*[A-Za-z][A-Za-z. ]*?)\\s+${LOCATION}\\s*$`,
    'i',
  ).exec(text.replace(/\s+/g, ' '));
  if (!match?.[1] || !match[2]) return null;
  const book = findBook(match[1]);
  if (!book) return null;
  return toRef(book, match[2], match[3], match[4]);
}

function toRef(
  book: BibleBook,
  chapter: string,
  verseStart?: string,
  verseEnd?: string,
): ScriptureRef {
  const start = verseStart ? Number(verseStart) : null;
  const end = verseEnd ? Number(verseEnd) : null;
  return {
    book: book.name,
    chapter: Number(chapter),
    verseStart: start,
    verseEnd: end === start ? null : end,
  };
}

// Detection in free text uses only unambiguous names (full names and aliases of 4+ letters).
const DETECTABLE_NAMES = [
  ...new Set(
    BIBLE_BOOKS.flatMap((book) =>
      [book.name, ...book.aliases]
        .filter((alias) => alias.replace(/^[1-3] /, '').length >= 4)
        .flatMap(withOrdinalVariants),
    ),
  ),
].sort((a, b) => b.length - a.length);

function withOrdinalVariants(name: string): string[] {
  const numbered = /^([1-3]) (.+)$/.exec(name);
  if (!numbered) return [name];
  const words: Record<string, string[]> = {
    '1': ['First', '1st', 'I'],
    '2': ['Second', '2nd', 'II'],
    '3': ['Third', '3rd', 'III'],
  };
  return [
    name,
    ...(words[numbered[1] ?? ''] ?? []).map(
      (ordinal) => `${ordinal} ${numbered[2]}`,
    ),
  ];
}

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DETECTION_PATTERN = new RegExp(
  `(?<![A-Za-z])(${DETECTABLE_NAMES.map((name) => escapeRegex(name).replace(/ /g, '\\s+')).join('|')})\\.?\\s+${LOCATION}(?![\\d:])`,
  'gi',
);

export interface DetectedReference {
  ref: ScriptureRef;
  matchText: string;
}

/** Finds scripture references in transcript text. Book names must be capitalised to limit false positives. */
export function detectReferences(text: string): DetectedReference[] {
  const found: DetectedReference[] = [];
  for (const match of text.matchAll(DETECTION_PATTERN)) {
    const [matchText, bookText, chapter, verseStart, verseEnd] = match;
    if (!bookText || !chapter || !/^[A-Z0-9]/.test(bookText)) continue;
    const book = findBook(bookText);
    if (!book) continue;
    const ref = toRef(book, chapter, verseStart, verseEnd);
    if (verifyReference(ref).valid)
      found.push({ ref, matchText: matchText.trim() });
  }
  return found;
}
