import type { CaptionCue } from '../../../brand/domain/captions.js';
import type {
  CaptionPosition,
  CaptionStyle,
  HookStyle,
  LogoPosition,
} from '../../../brand/domain/video-settings.js';
import {
  assColour,
  assText,
  assTime,
} from '../../../brand/infrastructure/rendering/ass-captions.js';

export interface ReelOverlayInput {
  width: number;
  height: number;
  /** Length of the sermon moment; the outro (if any) starts here. */
  clipMs: number;
  font: string;
  primaryColor: string;
  accentColor: string;
  hook: { text: string; style: HookStyle; durationMs: number } | null;
  captions: {
    style: CaptionStyle;
    position: CaptionPosition;
    cues: CaptionCue[];
  };
  labels: { speaker?: string; church?: string };
  logoPosition: LogoPosition;
  outro: {
    durationMs: number;
    churchName: string;
    handle?: string;
    website?: string;
  } | null;
}

const WHITE = '#FFFFFF';
const BLACK = '#000000';

/** Black or white, whichever reads better on the given background (WCAG relative luminance). */
export function readableOn(hex: string): string {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(1 + offset, 3 + offset), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance > 0.4 ? BLACK : WHITE;
}

const font = (name: string) => name.replace(/,/g, ' ');

/** Override-tag colour (`\c&HBBGGRR&`). */
const tagColour = (hex: string) => `${assColour(hex).replace('&H00', '&H')}&`;

interface Layout {
  captionAlign: number;
  captionMarginV: number;
  hookAlign: number;
  hookY: number;
}

/**
 * Keeps captions out of the platforms' UI zones (TikTok/Reels cover roughly the bottom fifth with
 * buttons and the caption) and puts the hook where the captions are not.
 */
function layoutFor(position: CaptionPosition, height: number): Layout {
  switch (position) {
    case 'top':
      return {
        captionAlign: 8,
        captionMarginV: Math.round(height * 0.16),
        hookAlign: 5,
        hookY: Math.round(height * 0.5),
      };
    case 'middle':
      return {
        captionAlign: 5,
        captionMarginV: 0,
        hookAlign: 8,
        hookY: Math.round(height * 0.14),
      };
    default:
      return {
        captionAlign: 2,
        captionMarginV: Math.round(height * 0.22),
        hookAlign: 8,
        hookY: Math.round(height * 0.14),
      };
  }
}

const dialogue = (
  layer: number,
  startMs: number,
  endMs: number,
  style: string,
  text: string,
) =>
  `Dialogue: ${layer},${assTime(startMs)},${assTime(endMs)},${style},,0,0,0,,${text}`;

function hookEvents(input: ReelOverlayInput, layout: Layout): string[] {
  const hook = input.hook;
  if (!hook || hook.durationMs <= 0) return [];
  const x = Math.round(input.width / 2);
  const y = layout.hookY;
  const end = hook.durationMs;
  const anchor = `\\an${layout.hookAlign}`;
  const text = assText(hook.text);
  switch (hook.style) {
    case 'IMPACT':
      return [
        dialogue(
          10,
          0,
          end,
          'HookBox',
          `{${anchor}\\pos(${x},${y})\\fad(0,250)\\fscx130\\fscy130\\t(0,180,\\fscx100\\fscy100)}${text.toUpperCase()}`,
        ),
      ];
    case 'QUESTION':
      return [
        dialogue(
          10,
          0,
          end,
          'HookQuestion',
          `{${anchor}\\move(${-input.width / 2},${y},${x},${y},0,280)\\fad(0,250)}${text}`,
        ),
      ];
    case 'MINIMAL':
      return [
        dialogue(
          10,
          0,
          end,
          'HookMinimal',
          `{${anchor}\\pos(${x},${y})\\fad(400,400)}${text}`,
        ),
      ];
    case 'HIGHLIGHT': {
      // The longest word carries the emphasis in the accent colour.
      const words = text.split(' ');
      const key = words.reduce(
        (best, word, index) =>
          word.replace(/\W/g, '').length >
          (words[best] ?? '').replace(/\W/g, '').length
            ? index
            : best,
        0,
      );
      const body = words
        .map((word, index) =>
          index === key
            ? `{\\c${tagColour(input.accentColor)}}${word}{\\c${tagColour(WHITE)}}`
            : word,
        )
        .join(' ');
      return [
        dialogue(
          10,
          0,
          end,
          'HookOutline',
          `{${anchor}\\pos(${x},${y})\\fad(150,250)}${body}`,
        ),
      ];
    }
    case 'TYPEWRITER': {
      // Karaoke timing with an invisible secondary colour: each character appears on its beat.
      // Split by grapheme so an emoji or accented letter is never cut in half.
      const chars = Array.from(
        new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
          text,
        ),
        (part) => part.segment,
      );
      const revealCs = Math.min(150, Math.round((end * 0.6) / 10));
      const perChar = Math.max(
        2,
        Math.floor(revealCs / Math.max(1, chars.length)),
      );
      const typed = chars.map((char) => `{\\k${perChar}}${char}`).join('');
      return [
        dialogue(
          10,
          0,
          end,
          'HookOutline',
          `{${anchor}\\pos(${x},${y})\\fad(0,250)\\2a&HFF&}${typed}`,
        ),
      ];
    }
  }
}

/** One event per word: the whole cue on screen, the spoken word in the accent colour. */
function highlightEvents(
  cue: CaptionCue,
  accent: string,
  style: string,
  transform: (word: string, active: boolean) => string,
): string[] {
  const words = cue.words ?? [];
  if (words.length === 0)
    return [dialogue(0, cue.startMs, cue.endMs, style, assText(cue.text))];
  const events: string[] = [];
  const first = words[0];
  if (first && first.startMs > cue.startMs)
    events.push(
      dialogue(
        0,
        cue.startMs,
        first.startMs,
        style,
        words.map((word) => transform(assText(word.text), false)).join(' '),
      ),
    );
  words.forEach((word, index) => {
    const end = words[index + 1]?.startMs ?? cue.endMs;
    if (end <= word.startMs) return;
    const text = words
      .map((other, position) => {
        const escaped = assText(other.text);
        return position === index
          ? `{\\c${tagColour(accent)}}${transform(escaped, true)}{\\c${tagColour(WHITE)}}`
          : transform(escaped, false);
      })
      .join(' ');
    events.push(dialogue(0, word.startMs, end, style, text));
  });
  return events;
}

function captionEvents(input: ReelOverlayInput): string[] {
  const { cues, style } = input.captions;
  const accent = input.accentColor;
  switch (style) {
    case 'CLEAN':
      return cues.map((cue) =>
        dialogue(
          0,
          cue.startMs,
          cue.endMs,
          'Caption',
          `{\\fad(60,60)}${assText(cue.text)}`,
        ),
      );
    case 'WORD_HIGHLIGHT':
      return cues.flatMap((cue) =>
        highlightEvents(cue, accent, 'Caption', (word) => word),
      );
    case 'POP':
      return cues.map((cue) =>
        dialogue(
          0,
          cue.startMs,
          cue.endMs,
          'CaptionBold',
          `{\\fscx70\\fscy70\\t(0,120,\\fscx108\\fscy108)\\t(120,200,\\fscx100\\fscy100)}${assText(cue.text).toUpperCase()}`,
        ),
      );
    case 'DYNAMIC':
      // Two or three words at a time, large; the spoken word grows slightly.
      return cues.flatMap((cue) => {
        const words = cue.words ?? [];
        if (words.length === 0)
          return [
            dialogue(
              0,
              cue.startMs,
              cue.endMs,
              'CaptionBig',
              assText(cue.text).toUpperCase(),
            ),
          ];
        const chunks: (typeof words)[] = [];
        for (const word of words) {
          const current = chunks[chunks.length - 1];
          const length =
            current?.reduce((sum, item) => sum + item.text.length + 1, 0) ?? 0;
          if (!current || current.length >= 3 || length + word.text.length > 16)
            chunks.push([word]);
          else current.push(word);
        }
        return chunks.flatMap((chunk, index) => {
          const end = chunks[index + 1]?.[0]?.startMs ?? cue.endMs;
          const startMs = chunk[0]?.startMs ?? cue.startMs;
          return highlightEvents(
            {
              startMs,
              endMs: end,
              text: chunk.map((word) => word.text).join(' '),
              words: chunk,
            },
            accent,
            'CaptionBig',
            (word, active) =>
              active
                ? `{\\fscx112\\fscy112}${word.toUpperCase()}{\\fscx100\\fscy100}`
                : word.toUpperCase(),
          );
        });
      });
  }
}

function labelEvents(input: ReelOverlayInput): string[] {
  const { speaker, church } = input.labels;
  if (!speaker && !church) return [];
  const margin = Math.round(input.width * 0.06);
  const right = input.logoPosition === 'top-left';
  const x = right ? input.width - margin : margin;
  const y = Math.round(input.height * 0.045);
  const lines = [
    speaker ? `{\\b1}${assText(speaker)}{\\b0}` : '',
    church ? `{\\fs${Math.round(input.width * 0.032)}}${assText(church)}` : '',
  ].filter(Boolean);
  const end = Math.min(input.clipMs, 6_500);
  if (end <= 400) return [];
  return [
    dialogue(
      5,
      400,
      end,
      'Label',
      `{\\an${right ? 9 : 7}\\pos(${x},${y})\\fad(250,300)}${lines.join('\\N')}`,
    ),
  ];
}

function outroEvents(input: ReelOverlayInput): string[] {
  const outro = input.outro;
  if (!outro || outro.durationMs <= 0) return [];
  const start = input.clipMs;
  const end = input.clipMs + outro.durationMs;
  const small = Math.round(input.width * 0.04);
  const lines = [
    `{\\b1}${assText(outro.churchName)}`,
    ...[outro.handle, outro.website]
      .filter((line): line is string => Boolean(line))
      .map((line) => `{\\b0\\fs${small}}${assText(line)}`),
  ];
  return [
    dialogue(
      20,
      start,
      end,
      'Outro',
      `{\\an8\\pos(${Math.round(input.width / 2)},${Math.round(input.height * 0.56)})\\fad(300,0)}${lines.join('\\N')}`,
    ),
  ];
}

/**
 * Builds the subtitle script libass burns into the Reel: animated hook, captions in the chosen
 * style, speaker/church label and the outro card text. All text is escaped (no override injection).
 */
export function buildReelAss(input: ReelOverlayInput): string {
  const { width: W, height: H } = input;
  const layout = layoutFor(input.captions.position, H);
  const f = font(input.font);
  const caption = Math.round(W * 0.066);
  const hook = Math.round(W * 0.078);
  const margin = Math.round(W * 0.08);
  const boxText = readableOn(input.accentColor);
  const questionText = readableOn(input.primaryColor);
  const style = (
    name: string,
    size: number,
    primary: string,
    outlineColour: string,
    back: string,
    bold: boolean,
    borderStyle: 1 | 3,
    outline: number,
    shadow: number,
    align: number,
    marginV: number,
  ) =>
    `Style: ${name},${f},${size},${assColour(primary)},${assColour(primary, 0xff)},${assColour(outlineColour)},${back},${bold ? -1 : 0},0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},${align},${margin},${margin},${marginV},1`;
  const shadowBack = assColour(BLACK, 0x80);
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    style(
      'Caption',
      caption,
      WHITE,
      BLACK,
      shadowBack,
      true,
      1,
      4,
      0,
      layout.captionAlign,
      layout.captionMarginV,
    ),
    style(
      'CaptionBold',
      Math.round(caption * 1.05),
      WHITE,
      BLACK,
      shadowBack,
      true,
      1,
      5,
      0,
      layout.captionAlign,
      layout.captionMarginV,
    ),
    style(
      'CaptionBig',
      Math.round(caption * 1.3),
      WHITE,
      BLACK,
      shadowBack,
      true,
      1,
      6,
      0,
      layout.captionAlign,
      layout.captionMarginV,
    ),
    style(
      'HookBox',
      hook,
      boxText,
      input.accentColor,
      assColour(input.accentColor),
      true,
      3,
      22,
      0,
      layout.hookAlign,
      0,
    ),
    style(
      'HookQuestion',
      hook,
      questionText,
      input.primaryColor,
      assColour(input.primaryColor),
      true,
      3,
      22,
      0,
      layout.hookAlign,
      0,
    ),
    style(
      'HookOutline',
      hook,
      WHITE,
      BLACK,
      shadowBack,
      true,
      1,
      5,
      2,
      layout.hookAlign,
      0,
    ),
    style(
      'HookMinimal',
      Math.round(hook * 0.85),
      WHITE,
      BLACK,
      shadowBack,
      false,
      1,
      2,
      3,
      layout.hookAlign,
      0,
    ),
    style(
      'Label',
      Math.round(W * 0.038),
      WHITE,
      BLACK,
      shadowBack,
      false,
      1,
      2,
      2,
      7,
      0,
    ),
    style(
      'Outro',
      Math.round(W * 0.07),
      readableOn(input.primaryColor),
      BLACK,
      shadowBack,
      true,
      1,
      0,
      0,
      8,
      0,
    ),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...captionEvents(input),
    ...hookEvents(input, layout),
    ...labelEvents(input),
    ...outroEvents(input),
    '',
  ].join('\n');
}
