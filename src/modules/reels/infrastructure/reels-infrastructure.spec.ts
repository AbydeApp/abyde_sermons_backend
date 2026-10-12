import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { deterministicId } from '../../../shared/domain/id.js';
import type { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service.js';
import { runProcess } from '../../../shared/infrastructure/process/run-process.js';
import { buildCaptionCues } from '../../brand/domain/captions.js';
import type { ReelRenderStage } from '../domain/reel.js';
import { cleanHooks } from '../application/services/reel-hook-ai.service.js';
import {
  PrismaReelCandidateRepository,
  PrismaReelRepository,
} from './persistence/prisma-reel.repositories.js';
import {
  FfmpegReelRenderer,
  parseProbe,
} from './rendering/ffmpeg-reel-renderer.js';
import {
  buildReelAss,
  readableOn,
  type ReelOverlayInput,
} from './rendering/reel-ass.js';
import {
  buildReelArgs,
  cropXExpression,
} from './rendering/reel-ffmpeg-args.js';
import { CommandSpeakerTracker } from './tracking/command-speaker-tracker.js';

const overlay = (
  overrides: Partial<ReelOverlayInput> = {},
): ReelOverlayInput => ({
  width: 1080,
  height: 1920,
  clipMs: 20_000,
  font: 'Inter',
  primaryColor: '#1F2A44',
  accentColor: '#F2B441',
  hook: { text: 'Faith is a step', style: 'IMPACT', durationMs: 3_000 },
  captions: {
    style: 'WORD_HIGHLIGHT',
    position: 'bottom',
    cues: [
      {
        startMs: 0,
        endMs: 1_500,
        text: 'Walk by faith',
        words: [
          { text: 'Walk', startMs: 0, endMs: 400 },
          { text: 'by', startMs: 400, endMs: 700 },
          { text: 'faith', startMs: 700, endMs: 1_500 },
        ],
      },
    ],
  },
  labels: { speaker: 'Pastor Ade', church: 'Grace Church' },
  logoPosition: 'top-right',
  outro: { durationMs: 2_500, churchName: 'Grace Church', handle: '@grace' },
  ...overrides,
});

const events = (ass: string) =>
  ass.split('\n').filter((line) => line.startsWith('Dialogue:'));

describe('Reel overlay (ASS)', () => {
  it('highlights the spoken word, one event per word', () => {
    const lines = events(
      buildReelAss(overlay({ hook: null, outro: null, labels: {} })),
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('0:00:00.40,0:00:00.70');
    expect(lines[1]).toContain('Walk {\\c&H41B4F2&}by{\\c&HFFFFFF&} faith');
  });

  it('animates each hook style differently', () => {
    const hookLine = (style: NonNullable<ReelOverlayInput['hook']>['style']) =>
      events(
        buildReelAss(
          overlay({
            hook: { text: 'Faith is a step', style, durationMs: 3_000 },
            captions: { style: 'CLEAN', position: 'bottom', cues: [] },
            labels: {},
            outro: null,
          }),
        ),
      )[0] ?? '';
    expect(hookLine('IMPACT')).toMatch(
      /HookBox.*\\t\(0,180,\\fscx100\\fscy100\)\}FAITH IS A STEP$/,
    );
    expect(hookLine('QUESTION')).toMatch(/HookQuestion.*\\move\(/);
    expect(hookLine('MINIMAL')).toMatch(/HookMinimal.*\\fad\(400,400\)/);
    expect(hookLine('HIGHLIGHT')).toContain(
      '{\\c&H41B4F2&}Faith{\\c&HFFFFFF&}',
    );
    expect(hookLine('TYPEWRITER')).toMatch(/\\2a&HFF&\}\{\\k\d+\}F\{\\k\d+\}a/);
  });

  it('renders pop and dynamic captions, and labels and outro text', () => {
    const pop = events(
      buildReelAss(
        overlay({ captions: { ...overlay().captions, style: 'POP' } }),
      ),
    );
    expect(
      pop.some(
        (line) =>
          line.includes('CaptionBold') && line.includes('WALK BY FAITH'),
      ),
    ).toBe(true);
    const dynamic = events(
      buildReelAss(
        overlay({ captions: { ...overlay().captions, style: 'DYNAMIC' } }),
      ),
    );
    expect(dynamic.filter((line) => line.includes('CaptionBig'))).toHaveLength(
      3,
    );
    const all = buildReelAss(overlay());
    expect(all).toContain('{\\b1}Pastor Ade{\\b0}\\N');
    expect(all).toMatch(/0:00:20\.00,0:00:22\.50,Outro/);
  });

  it('keeps captions clear of the hook and the platform UI', () => {
    const top = buildReelAss(
      overlay({ captions: { ...overlay().captions, position: 'top' } }),
    );
    expect(top).toMatch(/Style: Caption,Inter,71,.*,8,86,86,307,1/);
    expect(top).toMatch(/HookBox.*\\an5/);
  });

  it('escapes text so captions cannot inject override tags', () => {
    const ass = buildReelAss(
      overlay({
        hook: { text: 'Hi {\\fs200}', style: 'MINIMAL', durationMs: 3_000 },
        captions: {
          style: 'CLEAN',
          position: 'bottom',
          cues: [{ startMs: 0, endMs: 900, text: 'a{\\pos(0,0)}b' }],
        },
      }),
    );
    expect(ass).not.toContain('{\\fs200}');
    expect(ass).not.toContain('{\\pos(0,0)}');
  });

  it('picks readable text colours for brand boxes', () => {
    expect(readableOn('#F2B441')).toBe('#000000');
    expect(readableOn('#1F2A44')).toBe('#FFFFFF');
  });
});

describe('Reel ffmpeg arguments', () => {
  const base = {
    sourcePath: '/w/source',
    outputPath: '/w/reel.mp4',
    startMs: 61_500,
    endMs: 91_500,
    width: 1080,
    height: 1920,
    sourceHeight: 1080,
    hasAudio: true,
    assFile: 'reel.ass',
    logoPath: '/w/logo',
    logoPosition: 'top-right' as const,
    outroMs: 2_500,
    outroColor: '#1F2A44',
  };
  const graph = (args: string[]) =>
    args[args.indexOf('-filter_complex') + 1] ?? '';

  it('builds a piecewise-linear crop path', () => {
    expect(
      cropXExpression({
        cropWidth: 606,
        cropHeight: 1080,
        keyframes: [{ tMs: 0, x: 657 }],
      }),
    ).toBe('657');
    expect(
      cropXExpression({
        cropWidth: 606,
        cropHeight: 1080,
        keyframes: [
          { tMs: 0, x: 100 },
          { tMs: 2_000, x: 300 },
        ],
      }),
    ).toBe(
      'lt(t,0.000)*100+gte(t,0.000)*lt(t,2.000)*(100+(200)*(t-0.000)/2.000)+gte(t,2.000)*300',
    );
  });

  it('crops, cleans the real audio, appends the outro and stamps the logo', () => {
    const args = buildReelArgs({
      ...base,
      crop: {
        cropWidth: 606,
        cropHeight: 1080,
        keyframes: [{ tMs: 0, x: 657 }],
      },
    });
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 4)).toEqual([
      '-ss',
      '61.500',
      '-t',
      '30.000',
    ]);
    const filters = graph(args);
    expect(filters).toContain("crop=w=606:h=1080:x='657':y=0");
    expect(filters).toContain('loudnorm=I=-14:TP=-1.5:LRA=11');
    expect(filters).toContain('concat=n=2:v=1:a=1');
    expect(filters).toContain('subtitles=reel.ass');
    expect(filters).toContain("enable='lt(t,30.000)'");
    expect(filters).toContain("enable='gte(t,30.000)'");
    expect(args).toContain('-protocol_whitelist');
  });

  it('fits vertical sources, adds silence when there is no audio, and skips what is off', () => {
    const filters = graph(
      buildReelArgs({
        ...base,
        crop: null,
        hasAudio: false,
        outroMs: 0,
        logoPosition: 'none',
      }),
    );
    expect(filters).toContain('boxblur=20:2');
    expect(filters).toContain(
      'anullsrc=r=48000:cl=stereo,atrim=duration=30.000',
    );
    expect(filters).not.toContain('concat');
    // Logo position "none" and no outro: the logo is not used at all.
    expect(filters).not.toContain('[1:v]');
  });
});

describe('parseProbe', () => {
  it('reports the displayed size of rotated phone videos', () => {
    const probed = parseProbe(
      JSON.stringify({
        streams: [
          {
            codec_type: 'video',
            width: 1920,
            height: 1080,
            side_data_list: [{ rotation: -90 }],
          },
          { codec_type: 'audio' },
        ],
        format: { duration: '12.5' },
      }),
    );
    expect(probed).toEqual({
      width: 1080,
      height: 1920,
      durationMs: 12_500,
      hasAudio: true,
    });
  });

  it('rejects files without video', () => {
    expect(() =>
      parseProbe(JSON.stringify({ streams: [{ codec_type: 'audio' }] })),
    ).toThrow();
  });
});

describe('cleanHooks', () => {
  it('removes quote marks, duplicates, overlong and avoided hooks, keeping three', () => {
    expect(
      cleanHooks(
        [
          { text: '"Faith over fear"', style: 'IMPACT' },
          { text: 'faith over fear', style: 'MINIMAL' },
          { text: 'x'.repeat(120), style: 'IMPACT' },
          { text: 'You won’t BELIEVE this', style: 'QUESTION' },
          { text: 'Trust the next step', style: 'MINIMAL' },
          { text: 'Why wait to obey?', style: 'QUESTION' },
          { text: 'One more', style: 'HIGHLIGHT' },
        ],
        ['believe this'],
      ),
    ).toEqual([
      { text: 'Faith over fear', style: 'IMPACT' },
      { text: 'Trust the next step', style: 'MINIMAL' },
      { text: 'Why wait to obey?', style: 'QUESTION' },
    ]);
  });
});

describe('deterministicId', () => {
  it('is stable per seed and shaped like a UUID', () => {
    const id = deterministicId('reel:r1:1:video');
    expect(id).toBe(deterministicId('reel:r1:1:video'));
    expect(id).not.toBe(deterministicId('reel:r1:2:video'));
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('CommandSpeakerTracker', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tracker-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const script = async (body: string) => {
    const path = join(dir, 'tracker.mjs');
    await writeFile(path, body);
    return `${process.execPath} ${path}`;
  };

  it('passes the clip window and parses samples (no shell involved)', async () => {
    const command = await script(
      `const a = process.argv; const at = (f) => a[a.indexOf(f) + 1];
       console.log(JSON.stringify({ samples: [{ t: Number(at('--start')), cx: 0.6, confidence: Number(at('--fps')) / 10 }] }));`,
    );
    const result = await new CommandSpeakerTracker({
      command,
      timeoutMs: 10_000,
      sampleFps: 4,
    }).analyze({
      videoPath: join(dir, 'video; rm -rf /'),
      startMs: 61_500,
      endMs: 70_000,
    });
    expect(result).toEqual({
      provider: 'command',
      samples: [{ tMs: 61_500, cx: 0.6, confidence: 0.4 }],
    });
  });

  it('falls back to a centre crop when the tracker fails or prints garbage', async () => {
    for (const body of [
      'process.exit(3)',
      'console.log("not json")',
      'console.log(JSON.stringify({samples:[{t:"x"}]}))',
    ]) {
      const command = await script(body);
      const result = await new CommandSpeakerTracker({
        command,
        timeoutMs: 10_000,
        sampleFps: 2,
      }).analyze({
        videoPath: '/v',
        startMs: 0,
        endMs: 1_000,
      });
      expect(result).toEqual({ provider: 'center', samples: [] });
    }
  });
});

/** Records every Prisma call so the test can assert queries are always scoped by church_id. */
function recordingPrisma() {
  const calls: Array<{
    model: string;
    method: string;
    args: { where?: Record<string, unknown> };
  }> = [];
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get:
          (_target, method: string) =>
          async (args: { where?: Record<string, unknown> }) => {
            calls.push({ model: name, method, args });
            if (method === 'count') return 0;
            if (method === 'findMany') return [];
            if (method.endsWith('Many')) return { count: 0 };
            return null;
          },
      },
    );
  const db = new Proxy({}, { get: (_target, name: string) => model(name) });
  return { prisma: { db } as unknown as PrismaService, calls };
}

describe('Prisma reel adapters are church-scoped', () => {
  it('scopes every reel and candidate query by churchId', async () => {
    const { prisma, calls } = recordingPrisma();
    const reels = new PrismaReelRepository(prisma);
    const candidates = new PrismaReelCandidateRepository(prisma);
    await reels.findById('church-a', 'r1');
    await reels.list('church-a', { sermonId: 's1' }, { page: 1, pageSize: 20 });
    await reels.countRendering('church-a');
    await reels.advanceRender('church-a', 'r1', 1, 'CROPPING', 15);
    await reels.failRender('church-a', 'r1', 1, 'x');
    await reels.delete('church-a', 'r1');
    await candidates.listForSermon('church-a', 's1');
    await candidates.findById('church-a', 'k1');
    await candidates.replaceForSermon('church-a', 's1', []);
    expect(calls.length).toBeGreaterThanOrEqual(9);
    for (const call of calls)
      expect({
        call: `${call.model}.${call.method}`,
        scoped: JSON.stringify(call.args.where).includes(
          '"churchId":"church-a"',
        ),
      }).toEqual({
        call: `${call.model}.${call.method}`,
        scoped: true,
      });
  });
});

const hasFfmpeg =
  spawnSync('ffmpeg', ['-hide_banner', '-version']).status === 0;

/** Real encode of a synthetic landscape sermon clip (skipped where ffmpeg is not installed). */
describe.skipIf(!hasFfmpeg)('FfmpegReelRenderer (real ffmpeg)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reel-render-'));
    await runProcess(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1280x720:rate=30',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=220:sample_rate=48000',
        '-t',
        '12',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-c:a',
        'aac',
        join(dir, 'source.mp4'),
      ],
      { timeoutMs: 60_000 },
    );
    await sharp({
      create: { width: 300, height: 300, channels: 4, background: '#ff0000' },
    })
      .png()
      .toFile(join(dir, 'logo.png'));
  }, 60_000);
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('renders a branded 9:16 Reel with a moving crop, hook, captions, logo and outro', async () => {
    const renderer = new FfmpegReelRenderer('ffmpeg', 'ffprobe');
    const source = await renderer.probe(join(dir, 'source.mp4'));
    expect(source).toMatchObject({ width: 1280, height: 720, hasAudio: true });
    const stages: ReelRenderStage[] = [];
    const rendered = await renderer.render({
      workDir: dir,
      sourcePath: join(dir, 'source.mp4'),
      source,
      startMs: 2_000,
      endMs: 8_000,
      width: 540,
      height: 960,
      crop: {
        cropWidth: 404,
        cropHeight: 720,
        keyframes: [
          { tMs: 0, x: 100 },
          { tMs: 4_000, x: 800 },
        ],
      },
      hook: { text: 'Faith is a step', style: 'TYPEWRITER', durationMs: 2_000 },
      captions: {
        style: 'DYNAMIC',
        position: 'bottom',
        cues: buildCaptionCues(
          [
            {
              startTimeMs: 2_000,
              endTimeMs: 8_000,
              text: 'Walk by faith and not by sight every day.',
            },
          ],
          2_000,
          8_000,
        ),
      },
      labels: { speaker: 'Pastor Ade', church: 'Grace Church' },
      brand: {
        churchName: 'Grace Church',
        primaryColor: '#1F2A44',
        secondaryColor: '#3B5BA5',
        accentColor: '#F2B441',
        headingFont: 'Inter',
        bodyFont: 'Inter',
        socialHandle: '@grace',
        watermarkPosition: 'top-right',
      },
      logoPath: join(dir, 'logo.png'),
      logoPosition: 'top-right',
      outro: {
        durationMs: 2_000,
        churchName: 'Grace Church',
        handle: '@grace',
      },
      onStage: async (stage) => void stages.push(stage),
    });
    expect(stages).toEqual([
      'ADDING_HOOK',
      'ADDING_CAPTIONS',
      'BRANDING',
      'ENCODING',
    ]);
    expect(rendered).toMatchObject({
      contentType: 'video/mp4',
      width: 540,
      height: 960,
    });
    // 6 s moment + 2 s outro.
    expect(rendered.durationMs).toBeGreaterThan(7_800);
    expect(rendered.durationMs).toBeLessThan(8_300);
    const output = await renderer.probe(rendered.filePath);
    expect(output.hasAudio).toBe(true);
    expect((await stat(rendered.thumbnail.filePath)).size).toBeGreaterThan(
      1_000,
    );
    // The outro shows the big logo (pure red) centred in the upper half.
    const frame = join(dir, 'outro.png');
    await runProcess(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        '7.0',
        '-i',
        rendered.filePath,
        '-frames:v',
        '1',
        frame,
      ],
      {
        timeoutMs: 30_000,
      },
    );
    const { data } = await sharp(frame)
      .extract({ left: 268, top: 330, width: 4, height: 4 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(200);
    expect(data[1]).toBeLessThan(80);
  }, 120_000);
});
