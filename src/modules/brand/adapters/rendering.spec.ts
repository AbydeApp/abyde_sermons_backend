import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { resolveTemplate } from '../../domain/templates.js';
import {
  assColour,
  assText,
  assTime,
  buildAssCaptions,
} from './ass-captions.js';
import { buildClipArgs } from './ffmpeg-clip-args.js';
import { MediaRenderer } from './media-renderer.js';

const brand = {
  churchName: 'Grace',
  primaryColor: '#1F2A44',
  secondaryColor: '#3B5BA5',
  accentColor: '#F2B441',
  headingFont: 'Inter',
  bodyFont: 'Inter',
  watermarkPosition: 'bottom-right' as const,
};

describe('ffmpeg clip arguments', () => {
  it('cuts, reframes to 9:16, burns captions and stamps the logo', () => {
    const args = buildClipArgs({
      sourcePath: '/w/source',
      outputPath: '/w/clip.mp4',
      startMs: 61_500,
      endMs: 91_500,
      width: 1080,
      height: 1920,
      captionsFile: 'captions.ass',
      logoPath: '/w/logo',
      watermarkPosition: 'top-left',
    });
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 4)).toEqual([
      '-ss',
      '61.500',
      '-t',
      '30.000',
    ]);
    expect(args).toContain('-protocol_whitelist');
    const graph = args[args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).toContain('crop=1080:1920');
    expect(graph).toContain('subtitles=captions.ass');
    expect(graph).toContain('overlay=65:65');
    expect(args).toEqual(
      expect.arrayContaining(['-map', '0:a?', '-movflags', '+faststart']),
    );
  });

  it('omits caption and logo stages when there are none', () => {
    const graph = buildClipArgs({
      sourcePath: 's',
      outputPath: 'o',
      startMs: 0,
      endMs: 10_000,
      width: 1080,
      height: 1920,
      watermarkPosition: 'bottom-right',
    }).join(' ');
    expect(graph).not.toContain('subtitles');
    expect(graph).not.toContain('[1:v]');
  });
});

describe('ASS captions', () => {
  it('formats times and colours and neutralises override codes', () => {
    expect(assTime(3_723_456)).toBe('1:02:03.46');
    expect(assColour('#112233')).toBe('&H00332211');
    expect(assText('Hi {\\b1}there\\N now')).toBe('Hi (/b1)there/N now');
    const file = buildAssCaptions({
      cues: [{ startMs: 0, endMs: 1_000, text: 'Walk by faith' }],
      width: 1080,
      height: 1920,
      brand,
    });
    expect(file).toContain('PlayResY: 1920');
    expect(file).toContain(
      'Dialogue: 0,0:00:00.00,0:00:01.00,Caption,,0,0,0,,Walk by faith',
    );
  });
});

describe('MediaRenderer images (real sharp)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'render-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('rasterises a card and composites the logo', async () => {
    const logoPath = join(dir, 'logo.png');
    await sharp({
      create: { width: 400, height: 200, channels: 4, background: '#ff0000' },
    })
      .png()
      .toFile(logoPath);
    const rendered = await new MediaRenderer(
      'ffmpeg',
      'ffprobe',
    ).renderCarousel({
      workDir: dir,
      name: 'card',
      logoPath,
      cards: [1, 2].map((page) => ({
        template: resolveTemplate({
          format: 'carousel',
          contentType: 'SOCIAL_POST',
          churchDefaults: {},
        }),
        width: 1080,
        height: 1350,
        text: `Slide ${page}: faith over fear.`,
        pageLabel: `${page} / 2`,
        brand: { ...brand, logoObjectKey: 'churches/c1/brand/logo.png' },
      })),
    });
    expect(rendered).toHaveLength(2);
    const meta = await sharp(rendered[0]?.filePath).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 1080, height: 1350 });
    // The logo (pure red) is stamped bottom-right.
    const { data } = await sharp(rendered[0]?.filePath)
      .extract({
        left: 1080 - 65 - 75,
        top: 1350 - 65 - 80,
        width: 4,
        height: 4,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(200);
    expect(data[1]).toBeLessThan(60);
  });
});
