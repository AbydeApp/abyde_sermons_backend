/** Lower-cases and collapses punctuation/whitespace so quotes can be compared to transcript text. */
export function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .trim();
}

/** True when `quote` appears verbatim (ignoring case/punctuation) within `source`. */
export function isVerbatimExcerpt(quote: string, source: string): boolean {
  const needle = normalizeForComparison(quote);
  return needle.length > 0 && normalizeForComparison(source).includes(needle);
}

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
