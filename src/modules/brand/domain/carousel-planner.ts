export interface SlidePlan {
  heading?: string;
  text: string;
  attribution?: string;
}

export const MAX_CAROUSEL_SLIDES = 10;
const SLIDE_CHARS = 280;

/** Splits prose into chunks no longer than `maxChars`, breaking at sentence ends where possible. */
export function chunkText(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  for (const paragraph of text
    .split(/\n{2,}/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)) {
    const sentences = paragraph.match(/[^.!?]+[.!?]+["'”’)]*\s*|[^.!?]+$/g) ?? [
      paragraph,
    ];
    let current = '';
    for (const sentence of sentences
      .map((part) => part.trim())
      .filter(Boolean)) {
      if (sentence.length > maxChars) {
        if (current) chunks.push(current);
        current = '';
        // A single overlong sentence is split on word boundaries.
        let line = '';
        for (const word of sentence.split(' ')) {
          if (line && line.length + 1 + word.length > maxChars) {
            chunks.push(line);
            line = word;
          } else line = line ? `${line} ${word}` : word;
        }
        current = line;
      } else if (!current) current = sentence;
      else if (current.length + 1 + sentence.length <= maxChars)
        current += ` ${sentence}`;
      else {
        chunks.push(current);
        current = sentence;
      }
    }
    if (current) chunks.push(current);
  }
  return chunks;
}

/**
 * Lays content out as carousel slides: a cover with the title, the body in readable chunks, and
 * a closing slide pointing at the church when there is somewhere to point.
 */
export function planCarousel(input: {
  title: string;
  body: string;
  scripture?: string | null;
  churchName: string;
  callToAction?: string;
}): SlidePlan[] {
  const closing: SlidePlan | null = input.callToAction
    ? { heading: input.churchName, text: input.callToAction }
    : null;
  const bodyBudget = MAX_CAROUSEL_SLIDES - 1 - (closing ? 1 : 0);
  const chunks = chunkText(input.body, SLIDE_CHARS);
  const kept = chunks.slice(0, bodyBudget);
  if (chunks.length > bodyBudget && kept.length > 0) {
    const last = kept.length - 1;
    kept[last] = `${(kept[last] ?? '').replace(/[.!?…\s]+$/, '')}…`;
  }
  return [
    {
      heading: input.churchName,
      text: input.title,
      attribution: input.scripture ?? undefined,
    },
    ...kept.map((text) => ({ heading: input.title, text })),
    ...(closing ? [closing] : []),
  ];
}
