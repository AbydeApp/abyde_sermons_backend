/**
 * V1 serves Nigeria only. Africa/Lagos is WAT: UTC+1 with no daylight saving,
 * so a fixed offset is exact and avoids depending on the host's tz database.
 */
const LAGOS_OFFSET_MS = 60 * 60 * 1000;

/** UTC instants bounding the Africa/Lagos calendar month that contains `now`. */
export function lagosMonthRange(now: Date): { start: Date; end: Date } {
  const lagos = new Date(now.getTime() + LAGOS_OFFSET_MS);
  const year = lagos.getUTCFullYear();
  const month = lagos.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1) - LAGOS_OFFSET_MS),
    end: new Date(Date.UTC(year, month + 1, 1) - LAGOS_OFFSET_MS),
  };
}

/** Calendar year of an instant as observed in Africa/Lagos. */
export const lagosYear = (instant: Date): number =>
  new Date(instant.getTime() + LAGOS_OFFSET_MS).getUTCFullYear();

/** UTC instants bounding a Lagos calendar year. */
export function lagosYearRange(year: number): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(year, 0, 1) - LAGOS_OFFSET_MS),
    end: new Date(Date.UTC(year + 1, 0, 1) - LAGOS_OFFSET_MS),
  };
}
