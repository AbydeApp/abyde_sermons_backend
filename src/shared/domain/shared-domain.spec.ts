import { lagosMonthRange, lagosYear } from './lagos-time.js';
import { isVerbatimExcerpt, slugify } from './text.js';

describe('Africa/Lagos time', () => {
  it('computes calendar months in WAT (UTC+1)', () => {
    // 23:30 UTC on 31 Oct is already 1 Nov in Lagos.
    const { start, end } = lagosMonthRange(new Date('2026-10-31T23:30:00Z'));
    expect(start.toISOString()).toBe('2026-10-31T23:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-30T23:00:00.000Z');
    expect(lagosYear(new Date('2026-12-31T23:30:00Z'))).toBe(2027);
  });
});

describe('text helpers', () => {
  it('matches verbatim quotes ignoring case and punctuation only', () => {
    const source =
      'God did not show us the whole road — but He gave us enough light for the next step.';
    expect(
      isVerbatimExcerpt('he gave us enough light for the next step', source),
    ).toBe(true);
    expect(
      isVerbatimExcerpt('He gave us all the light we needed', source),
    ).toBe(false);
    expect(isVerbatimExcerpt('', source)).toBe(false);
  });

  it('slugifies names', () => {
    expect(slugify('Église de la Grâce — Lagos!')).toBe(
      'eglise-de-la-grace-lagos',
    );
  });
});
