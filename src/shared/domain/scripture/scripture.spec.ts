import { BIBLE_BOOKS } from './bible-books.js';
import {
  detectReferences,
  findBook,
  formatReference,
  parseReference,
  verifyReference,
} from './scripture.js';

const BOOK_TOTALS: Record<string, number> = {
  Genesis: 1533,
  Exodus: 1213,
  Leviticus: 859,
  Numbers: 1288,
  Deuteronomy: 959,
  Joshua: 658,
  Judges: 618,
  Ruth: 85,
  '1 Samuel': 810,
  '2 Samuel': 695,
  '1 Kings': 816,
  '2 Kings': 719,
  '1 Chronicles': 942,
  '2 Chronicles': 822,
  Ezra: 280,
  Nehemiah: 406,
  Esther: 167,
  Job: 1070,
  Psalms: 2461,
  Proverbs: 915,
  Ecclesiastes: 222,
  'Song of Songs': 117,
  Isaiah: 1292,
  Jeremiah: 1364,
  Lamentations: 154,
  Ezekiel: 1273,
  Daniel: 357,
  Hosea: 197,
  Joel: 73,
  Amos: 146,
  Obadiah: 21,
  Jonah: 48,
  Micah: 105,
  Nahum: 47,
  Habakkuk: 56,
  Zephaniah: 53,
  Haggai: 38,
  Zechariah: 211,
  Malachi: 55,
  Matthew: 1071,
  Mark: 678,
  Luke: 1151,
  John: 879,
  Acts: 1007,
  Romans: 433,
  '1 Corinthians': 437,
  '2 Corinthians': 257,
  Galatians: 149,
  Ephesians: 155,
  Philippians: 104,
  Colossians: 95,
  '1 Thessalonians': 89,
  '2 Thessalonians': 47,
  '1 Timothy': 113,
  '2 Timothy': 83,
  Titus: 46,
  Philemon: 25,
  Hebrews: 303,
  James: 108,
  '1 Peter': 105,
  '2 Peter': 61,
  '1 John': 105,
  '2 John': 13,
  '3 John': 15,
  Jude: 25,
  Revelation: 404,
};

describe('Bible verse table', () => {
  it('has 66 books and 1,189 chapters', () => {
    expect(BIBLE_BOOKS).toHaveLength(66);
    expect(BIBLE_BOOKS.reduce((sum, book) => sum + book.verses.length, 0)).toBe(
      1189,
    );
  });

  it.each(Object.entries(BOOK_TOTALS))(
    '%s has the canonical verse total',
    (name, total) => {
      const book = BIBLE_BOOKS.find((candidate) => candidate.name === name);
      expect(book?.verses.reduce((sum, count) => sum + count, 0)).toBe(total);
    },
  );
});

describe('scripture parsing and verification', () => {
  it('normalises book names, abbreviations and ordinals', () => {
    expect(findBook('1 Cor')?.name).toBe('1 Corinthians');
    expect(findBook('First Corinthians')?.name).toBe('1 Corinthians');
    expect(findBook('II Kings')?.name).toBe('2 Kings');
    expect(findBook('Psalm')?.name).toBe('Psalms');
    expect(findBook('Song of Solomon')?.name).toBe('Song of Songs');
    expect(findBook('Hezekiah')).toBeNull();
  });

  it('parses written and spoken references', () => {
    expect(parseReference('John 3:16-18')).toEqual({
      book: 'John',
      chapter: 3,
      verseStart: 16,
      verseEnd: 18,
    });
    expect(parseReference('2 Corinthians 5:7')).toEqual({
      book: '2 Corinthians',
      chapter: 5,
      verseStart: 7,
      verseEnd: null,
    });
    expect(parseReference('Romans 8')).toEqual({
      book: 'Romans',
      chapter: 8,
      verseStart: null,
      verseEnd: null,
    });
    expect(parseReference('First John chapter 4 verse 8')).toEqual({
      book: '1 John',
      chapter: 4,
      verseStart: 8,
      verseEnd: null,
    });
    expect(parseReference('not a verse')).toBeNull();
  });

  it('rejects references outside canonical bounds', () => {
    expect(
      verifyReference({
        book: 'John',
        chapter: 3,
        verseStart: 16,
        verseEnd: null,
      }).valid,
    ).toBe(true);
    expect(
      verifyReference({
        book: 'John',
        chapter: 22,
        verseStart: 1,
        verseEnd: null,
      }).valid,
    ).toBe(false);
    expect(
      verifyReference({
        book: 'Jude',
        chapter: 1,
        verseStart: 26,
        verseEnd: null,
      }).valid,
    ).toBe(false);
    expect(
      verifyReference({
        book: 'Psalms',
        chapter: 119,
        verseStart: 170,
        verseEnd: 176,
      }).valid,
    ).toBe(true);
    expect(
      verifyReference({
        book: 'Romans',
        chapter: 8,
        verseStart: 28,
        verseEnd: 20,
      }).valid,
    ).toBe(false);
  });

  it('formats display strings', () => {
    expect(
      formatReference({
        book: 'Psalms',
        chapter: 23,
        verseStart: null,
        verseEnd: null,
      }),
    ).toBe('Psalm 23');
    expect(
      formatReference({
        book: 'John',
        chapter: 3,
        verseStart: 16,
        verseEnd: 18,
      }),
    ).toBe('John 3:16-18');
  });

  it('detects verified references in transcript prose', () => {
    const text =
      'Turn with me to Hebrews 11:1. Later, in Romans chapter 8 verse 28, Paul writes. Mark 99 is not real, and mark 5 is lower-case.';
    expect(detectReferences(text).map((d) => formatReference(d.ref))).toEqual([
      'Hebrews 11:1',
      'Romans 8:28',
    ]);
  });
});
