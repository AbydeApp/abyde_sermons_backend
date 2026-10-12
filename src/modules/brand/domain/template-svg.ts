import type { BrandSnapshot, WatermarkPosition } from './brand-profile.js';
import type { TemplateDefinition } from './templates.js';

/** Everything needed to draw one card. Pure data: the same spec always yields the same image. */
export interface CardSpec {
  template: TemplateDefinition;
  width: number;
  height: number;
  /** Small label above the text (sermon or slide title). */
  heading?: string;
  text: string;
  /** e.g. a scripture reference. */
  attribution?: string;
  /** e.g. "2 / 5" on carousel slides. */
  pageLabel?: string;
  brand: BrandSnapshot;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Longest text one card may carry; longer content belongs in a carousel. */
export const MAX_CARD_CHARS = 600;

const LIGHT_BACKGROUND = '#FAF9F6';
const DARK_TEXT = '#161616';
const LIGHT_TEXT = '#FFFFFF';
/** Average glyph advance as a share of the font size (sans-serif estimate). */
const GLYPH_WIDTH = 0.54;
const LINE_HEIGHT = 1.28;

export const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Control characters are not valid in XML 1.0.
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** Relative luminance (WCAG) of a #RRGGBB colour. */
export function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Black or white, whichever reads better on the background. */
export const readableOn = (background: string): string =>
  luminance(background) > 0.4 ? DARK_TEXT : LIGHT_TEXT;

/** Greedy word wrap; a word longer than the line is split. */
export function wrapText(text: string, maxChars: number): string[] {
  const limit = Math.max(1, maxChars);
  const lines: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    let line = '';
    for (const word of paragraph.trim().split(/\s+/).filter(Boolean)) {
      let rest = word;
      while (rest.length > limit) {
        if (line) {
          lines.push(line);
          line = '';
        }
        lines.push(rest.slice(0, limit));
        rest = rest.slice(limit);
      }
      if (!line) line = rest;
      else if (line.length + 1 + rest.length <= limit) line += ` ${rest}`;
      else {
        lines.push(line);
        line = rest;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

interface FittedText {
  fontSize: number;
  lines: string[];
}

/** Largest font size (within bounds) at which the text fits the box; truncates as a last resort. */
export function fitText(
  text: string,
  box: { width: number; height: number },
  bounds: { max: number; min: number },
): FittedText {
  for (let fontSize = bounds.max; fontSize >= bounds.min; fontSize -= 2) {
    const lines = wrapText(
      text,
      Math.floor(box.width / (fontSize * GLYPH_WIDTH)),
    );
    if (lines.length * fontSize * LINE_HEIGHT <= box.height)
      return { fontSize, lines };
  }
  const fontSize = bounds.min;
  const maxLines = Math.max(
    1,
    Math.floor(box.height / (fontSize * LINE_HEIGHT)),
  );
  const lines = wrapText(
    text,
    Math.floor(box.width / (fontSize * GLYPH_WIDTH)),
  ).slice(0, maxLines);
  const last = lines.length - 1;
  lines[last] = `${(lines[last] ?? '').replace(/.{0,1}$/, '')}…`;
  return { fontSize, lines };
}

/** Where the logo is stamped. The renderer composites the bitmap; the SVG leaves the space free. */
export function logoBox(
  width: number,
  height: number,
  position: WatermarkPosition,
): Box {
  const size = Math.round(width * 0.14);
  const margin = Math.round(width * 0.06);
  return {
    x: position.endsWith('left') ? margin : width - margin - size,
    y: position.startsWith('top') ? margin : height - margin - size,
    width: size,
    height: size,
  };
}

const fontStack = (family: string): string =>
  `'${family}', Inter, 'DejaVu Sans', 'Liberation Sans', sans-serif`;

/** Renders a card as an SVG document. No external references, scripts or user-controlled markup. */
export function renderCardSvg(spec: CardSpec): string {
  const { width, height, brand, template } = spec;
  const padding = Math.round(width * 0.09);
  const background =
    template.background === 'light' ? LIGHT_BACKGROUND : brand.primaryColor;
  // On the light template the brand colour is the text colour, unless it is too pale to read.
  const textColor =
    template.background === 'light'
      ? luminance(brand.primaryColor) < 0.4
        ? brand.primaryColor
        : DARK_TEXT
      : readableOn(brand.primaryColor);
  const mutedOpacity = 0.72;
  const logo = brand.logoObjectKey
    ? logoBox(width, height, brand.watermarkPosition)
    : null;

  // Vertical bands: heading at the top, footer at the bottom, text centred in what is left.
  const headingSize = Math.round(width * 0.03);
  const footerSize = Math.round(width * 0.028);
  const top =
    padding +
    (spec.heading || (logo && brand.watermarkPosition.startsWith('top'))
      ? Math.round(width * 0.14)
      : 0);
  const bottom =
    height -
    padding -
    Math.round(
      width *
        (logo && brand.watermarkPosition.startsWith('bottom') ? 0.16 : 0.07),
    );
  const attributionSize = Math.round(width * 0.034);
  const attributionSpace = spec.attribution ? attributionSize * 2.4 : 0;
  const quoteSpace = template.quoteMark ? Math.round(width * 0.11) : 0;
  const textBox = {
    width: width - padding * 2,
    height: Math.max(
      footerSize * 2,
      bottom - top - attributionSpace - quoteSpace,
    ),
  };
  const fitted = fitText(spec.text, textBox, {
    max: Math.round(width * 0.07),
    min: Math.round(width * 0.03),
  });
  const lineHeight = fitted.fontSize * LINE_HEIGHT;
  const blockHeight = fitted.lines.length * lineHeight;
  const blockTop =
    top + quoteSpace + (textBox.height - blockHeight) / 2 + fitted.fontSize;
  const centre = width / 2;
  const heading = fontStack(brand.headingFont);
  const body = fontStack(brand.bodyFont);

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  ];
  if (template.background === 'gradient') {
    parts.push(
      `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${brand.primaryColor}"/><stop offset="1" stop-color="${brand.secondaryColor}"/></linearGradient></defs>`,
      `<rect width="${width}" height="${height}" fill="url(#bg)"/>`,
    );
  } else {
    parts.push(
      `<rect width="${width}" height="${height}" fill="${background}"/>`,
    );
  }
  if (template.background === 'light') {
    parts.push(
      `<rect x="${padding}" y="${padding}" width="${Math.round(width * 0.12)}" height="${Math.round(width * 0.012)}" fill="${brand.accentColor}"/>`,
    );
  }
  if (spec.heading) {
    const headingOnLeft = !(logo && brand.watermarkPosition === 'top-left');
    parts.push(
      `<text x="${headingOnLeft ? padding : width - padding}" y="${padding + headingSize + Math.round(width * 0.04)}" text-anchor="${headingOnLeft ? 'start' : 'end'}" font-family="${heading}" font-size="${headingSize}" font-weight="700" letter-spacing="${(headingSize * 0.08).toFixed(1)}" fill="${textColor}" fill-opacity="${mutedOpacity}">${escapeXml(wrapText(spec.heading.toUpperCase(), 44)[0] ?? '')}</text>`,
    );
  }
  if (template.quoteMark) {
    parts.push(
      `<text x="${centre}" y="${Math.round(blockTop - fitted.fontSize - quoteSpace * 0.1)}" text-anchor="middle" font-family="Georgia, 'DejaVu Serif', serif" font-size="${Math.round(width * 0.16)}" fill="${brand.accentColor}">“</text>`,
    );
  }
  parts.push(
    `<text text-anchor="middle" font-family="${heading}" font-size="${fitted.fontSize}" font-weight="700" fill="${textColor}">${fitted.lines
      .map(
        (line, index) =>
          `<tspan x="${centre}" y="${(blockTop + index * lineHeight).toFixed(1)}">${escapeXml(line)}</tspan>`,
      )
      .join('')}</text>`,
  );
  if (spec.attribution) {
    parts.push(
      `<text x="${centre}" y="${(blockTop + blockHeight + attributionSize * 0.9).toFixed(1)}" text-anchor="middle" font-family="${body}" font-size="${attributionSize}" font-weight="600" fill="${template.background === 'light' ? brand.secondaryColor : brand.accentColor}">${escapeXml(wrapText(spec.attribution, 48)[0] ?? '')}</text>`,
    );
  }
  const footer = brand.socialHandle ?? brand.website ?? brand.churchName;
  const footerOnLeft = !(logo && brand.watermarkPosition === 'bottom-left');
  parts.push(
    `<text x="${footerOnLeft ? padding : width - padding}" y="${height - padding}" text-anchor="${footerOnLeft ? 'start' : 'end'}" font-family="${body}" font-size="${footerSize}" fill="${textColor}" fill-opacity="${mutedOpacity}">${escapeXml(footer.replace(/^https?:\/\//, ''))}</text>`,
  );
  if (spec.pageLabel) {
    const labelOnRight =
      footerOnLeft && !(logo && brand.watermarkPosition === 'bottom-right');
    parts.push(
      `<text x="${labelOnRight ? width - padding : centre}" y="${height - padding}" text-anchor="${labelOnRight ? 'end' : 'middle'}" font-family="${body}" font-size="${footerSize}" fill="${textColor}" fill-opacity="${mutedOpacity}">${escapeXml(spec.pageLabel)}</text>`,
    );
  }
  parts.push('</svg>');
  return parts.join('');
}
