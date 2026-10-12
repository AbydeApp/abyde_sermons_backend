import { applyBrandPatch, defaultBrandProfile } from './brand-profile.js';
import { buildCaptionCues } from './captions.js';
import {
  chunkText,
  MAX_CAROUSEL_SLIDES,
  planCarousel,
} from './carousel-planner.js';
import { resolveClipWindow } from './clip-window.js';
import {
  brandAssetKey,
  generatedAssetKey,
  validateLogoUpload,
} from './media-asset.js';
import { resolveTemplate } from './templates.js';
import {
  escapeXml,
  fitText,
  readableOn,
  renderCardSvg,
  wrapText,
} from './template-svg.js';

const profile = () =>
  defaultBrandProfile({
    id: 'b1',
    churchId: 'c1',
    churchName: 'Grace Church',
    primaryColor: '#112233',
  });

describe('brand profile', () => {
  it('seeds defaults from the church and normalises patches', () => {
    const next = applyBrandPatch(profile(), {
      primaryColor: '#abcdef',
      socialHandle: 'gracechurch',
      watermarkEnabled: true,
      watermarkPosition: 'top-left',
      voice: {
        hashtagPreferences: ['faith', '#hope', 'faith'],
        emojiUsage: 'none',
      },
    });
    expect(next).toMatchObject({
      primaryColor: '#ABCDEF',
      secondaryColor: '#3B5BA5',
      socialHandle: '@gracechurch',
      watermarkPosition: 'top-left',
      voice: { hashtagPreferences: ['#faith', '#hope'], emojiUsage: 'none' },
    });
  });

  it('clears optional fields with null and rejects invalid values', () => {
    const withSite = applyBrandPatch(profile(), {
      website: 'https://grace.example',
    });
    expect(
      applyBrandPatch(withSite, { website: null }).website,
    ).toBeUndefined();
    for (const patch of [
      { primaryColor: 'red' },
      { headingFont: 'Inter"><script>' },
      { website: 'javascript:alert(1)' },
      { socialHandle: 'not a handle!' },
      { churchName: '  ' },
    ])
      expect(() => applyBrandPatch(profile(), patch)).toThrow(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
  });
});

describe('templates', () => {
  it('uses the requested template, else the church default, else the catalog default', () => {
    expect(
      resolveTemplate({
        format: 'image',
        contentType: 'QUOTE',
        requested: 'gradient-quote',
        churchDefaults: {},
      }).id,
    ).toBe('gradient-quote');
    expect(
      resolveTemplate({
        format: 'image',
        contentType: 'QUOTE',
        churchDefaults: { QUOTE: 'minimal-light' },
      }).id,
    ).toBe('minimal-light');
    // A default that cannot render the format falls back to the catalog.
    expect(
      resolveTemplate({
        format: 'video',
        contentType: 'QUOTE',
        churchDefaults: { QUOTE: 'minimal-light' },
      }).id,
    ).toBe('captioned-clip');
    expect(() =>
      resolveTemplate({
        format: 'video',
        contentType: 'QUOTE',
        requested: 'bold-quote',
        churchDefaults: {},
      }),
    ).toThrow();
  });
});

describe('card SVG', () => {
  const brand = {
    churchName: 'Grace & Truth',
    primaryColor: '#112233',
    secondaryColor: '#334455',
    accentColor: '#FFCC00',
    headingFont: 'Inter',
    bodyFont: 'Inter',
    watermarkPosition: 'bottom-right' as const,
  };

  it('escapes every piece of user text (no markup injection)', () => {
    const svg = renderCardSvg({
      template: resolveTemplate({
        format: 'image',
        contentType: 'QUOTE',
        churchDefaults: {},
      }),
      width: 1080,
      height: 1080,
      heading: '<b>heading</b>',
      text: 'Faith </text><script>alert(1)</script> & hope',
      attribution: 'John "3:16"',
      brand,
    });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('Grace &amp; Truth');
    expect(svg).not.toMatch(/href=|xlink/);
    expect(escapeXml('a\u0001b')).toBe('ab');
  });

  it('wraps, fits and picks readable text colours', () => {
    expect(wrapText('one two three four', 9)).toEqual([
      'one two',
      'three',
      'four',
    ]);
    expect(wrapText('supercalifragilistic', 5)).toEqual([
      'super',
      'calif',
      'ragil',
      'istic',
    ]);
    const fitted = fitText(
      'word '.repeat(400),
      { width: 900, height: 300 },
      { max: 70, min: 30 },
    );
    expect(fitted.fontSize).toBe(30);
    expect(fitted.lines.at(-1)).toMatch(/…$/);
    expect(readableOn('#FFFFFF')).toBe('#161616');
    expect(readableOn('#000000')).toBe('#FFFFFF');
  });
});

describe('carousel planning', () => {
  it('splits at sentence boundaries and caps the slide count', () => {
    expect(chunkText('One. Two! Three?', 10)).toEqual(['One. Two!', 'Three?']);
    const slides = planCarousel({
      title: 'Walking by faith',
      body: Array.from(
        { length: 120 },
        (_, i) => `Sentence number ${i} about faith and courage.`,
      ).join(' '),
      scripture: '2 Corinthians 5:7',
      churchName: 'Grace',
      callToAction: 'Join us Sunday at 9am',
    });
    expect(slides).toHaveLength(MAX_CAROUSEL_SLIDES);
    expect(slides[0]).toMatchObject({
      text: 'Walking by faith',
      attribution: '2 Corinthians 5:7',
    });
    expect(slides.at(-1)).toMatchObject({ text: 'Join us Sunday at 9am' });
    expect(slides.at(-2)?.text).toMatch(/…$/);
  });
});

describe('captions', () => {
  it('builds short, non-overlapping cues relative to the clip start', () => {
    const cues = buildCaptionCues(
      [
        {
          startTimeMs: 0,
          endTimeMs: 10_000,
          text: 'Faith is the substance of things hoped for. The evidence of things not seen.',
        },
        { startTimeMs: 10_000, endTimeMs: 20_000, text: 'Walk by faith.' },
      ],
      5_000,
      15_000,
    );
    expect(cues.length).toBeGreaterThan(1);
    expect(cues[0]?.startMs).toBeGreaterThanOrEqual(0);
    expect(cues.at(-1)?.endMs).toBeLessThanOrEqual(10_000);
    for (let i = 1; i < cues.length; i++)
      expect(cues[i]?.startMs).toBeGreaterThanOrEqual(cues[i - 1]?.endMs ?? 0);
    expect(cues.every((cue) => cue.text.split(' ').length <= 6)).toBe(true);
    // "faith." is spoken after the clip ends, so it is not captioned.
    expect(cues.map((cue) => cue.text).join(' ')).toMatch(/Walk by$/);
  });

  it('uses real word timings when the transcript has them', () => {
    const cues = buildCaptionCues(
      [
        {
          startTimeMs: 0,
          endTimeMs: 10_000,
          text: 'Trust God today.',
          // Uneven pacing that a character-share estimate would get wrong.
          words: [
            { text: 'Trust', startMs: 1_000, endMs: 1_400 },
            { text: 'God', startMs: 6_000, endMs: 6_300 },
            { text: 'today.', startMs: 6_300, endMs: 7_000 },
          ],
        },
      ],
      500,
      9_000,
    );
    expect(cues).toEqual([
      {
        startMs: 500,
        endMs: 6_500,
        text: 'Trust God today.',
        words: [
          { text: 'Trust', startMs: 500, endMs: 900 },
          { text: 'God', startMs: 5_500, endMs: 5_800 },
          { text: 'today.', startMs: 5_800, endMs: 6_500 },
        ],
      },
    ]);
  });
});

describe('clip window', () => {
  const base = { sermonDurationMs: 3_600_000, maxClipMs: 180_000 };

  it('defaults to the first minute of the source passage', () => {
    expect(
      resolveClipWindow({
        ...base,
        source: { startTimeMs: 60_000, endTimeMs: 400_000 },
      }),
    ).toEqual({
      startMs: 60_000,
      endMs: 120_000,
    });
  });

  it('validates explicit windows', () => {
    const source = { startTimeMs: null, endTimeMs: null };
    expect(() => resolveClipWindow({ ...base, source })).toThrow(
      expect.objectContaining({
        fieldErrors: { clip: [expect.stringMatching(/timestamps/)] },
      }),
    );
    expect(() =>
      resolveClipWindow({
        ...base,
        source,
        requested: { startMs: 0, endMs: 2_000 },
      }),
    ).toThrow();
    expect(() =>
      resolveClipWindow({
        ...base,
        source,
        requested: { startMs: 0, endMs: 200_000 },
      }),
    ).toThrow();
    expect(() =>
      resolveClipWindow({
        ...base,
        source,
        requested: { startMs: 3_590_000, endMs: 3_620_000 },
      }),
    ).toThrow();
    expect(
      resolveClipWindow({
        ...base,
        source,
        requested: { startMs: 10_000, endMs: 40_000 },
      }),
    ).toEqual({
      startMs: 10_000,
      endMs: 40_000,
    });
  });
});

describe('media assets', () => {
  it('accepts raster logos only and builds church-scoped keys', () => {
    expect(
      validateLogoUpload({
        fileName: 'logo.PNG',
        contentType: 'image/png',
        sizeBytes: 10,
      }),
    ).toEqual({
      contentType: 'image/png',
      extension: 'png',
    });
    expect(() =>
      validateLogoUpload({
        fileName: 'logo.svg',
        contentType: 'image/svg+xml',
        sizeBytes: 10,
      }),
    ).toThrow();
    expect(() =>
      validateLogoUpload({
        fileName: 'logo.png',
        contentType: 'image/png',
        sizeBytes: 6 * 1024 ** 2,
      }),
    ).toThrow();
    expect(brandAssetKey('c1', 'a1', 'png')).toBe('churches/c1/brand/a1.png');
    expect(generatedAssetKey('c1', 's1', 'VIDEO', 'a1', 'mp4')).toBe(
      'churches/c1/sermons/s1/generated/reels/a1.mp4',
    );
  });
});
