import type { BrandSnapshot, CaptionCue } from '../helper.js';

/** H:MM:SS.cc as ASS expects. */
export function assTime(ms: number): string {
  const centis = Math.max(0, Math.round(ms / 10));
  const hours = Math.floor(centis / 360_000);
  const minutes = Math.floor((centis % 360_000) / 6_000);
  const seconds = Math.floor((centis % 6_000) / 100);
  const rest = centis % 100;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(rest)}`;
}

/** #RRGGBB → ASS &HAABBGGRR (alpha 00 = opaque). */
export function assColour(hex: string, alpha = 0): string {
  const value = hex.replace('#', '').toUpperCase();
  const [r, g, b] = [value.slice(0, 2), value.slice(2, 4), value.slice(4, 6)];
  return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${b}${g}${r}`;
}

/** Caption text can never open an override block or inject a line break code. */
export const assText = (text: string): string =>
  text
    .replace(/[{}]/g, (brace) => (brace === '{' ? '(' : ')'))
    .replace(/\\/g, '/')
    .replace(/\s+/g, ' ')
    .trim();

/** Styled subtitles burned into the clip: brand heading font, white text, dark outline. */
export function buildAssCaptions(input: {
  cues: CaptionCue[];
  width: number;
  height: number;
  brand: Pick<BrandSnapshot, 'headingFont' | 'accentColor'>;
}): string {
  const fontSize = Math.round(input.width * 0.062);
  const marginV = Math.round(input.height * 0.2);
  const margin = Math.round(input.width * 0.08);
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${input.width}`,
    `PlayResY: ${input.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${input.brand.headingFont.replace(/,/g, ' ')},${fontSize},${assColour('#FFFFFF')},${assColour(input.brand.accentColor)},${assColour('#000000')},${assColour('#000000', 0x80)},-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(fontSize / 14))},0,2,${margin},${margin},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...input.cues.map(
      (cue) =>
        `Dialogue: 0,${assTime(cue.startMs)},${assTime(cue.endMs)},Caption,,0,0,0,,${assText(cue.text)}`,
    ),
    '',
  ].join('\n');
}
