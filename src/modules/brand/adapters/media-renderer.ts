import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { PermanentJobError } from '../../../shared/application/jobs.js';
import { runProcess } from '../../../shared/infrastructure/process/run-process.js';
import { logoBox, renderCardSvg } from './template-svg.js';
import type {
  BrandRenderingPort,
  RenderCarouselInput,
  RenderedMedia,
  RenderImageInput,
  RenderThumbnailInput,
  RenderVideoInput,
} from './ports.js';
import { buildAssCaptions } from './ass-captions.js';
import { buildClipArgs, buildThumbnailArgs } from './ffmpeg-clip-args.js';

const ENCODE_TIMEOUT_MS = 20 * 60 * 1000;
const PROBE_TIMEOUT_MS = 60 * 1000;

/** Bounded per process: an SVG rasterisation holds the whole bitmap in memory. */
sharp.concurrency(1);
sharp.cache(false);

/**
 * Images: deterministic SVG templates rasterised with sharp (librsvg), logo composited as a bitmap.
 * Video: ffmpeg (clip, 9:16, captions, logo). Fonts come from the system's fontconfig.
 */
export class MediaRenderer implements BrandRenderingPort {
  constructor(
    private readonly ffmpegPath: string,
    private readonly ffprobePath: string,
  ) {}

  async renderImage(input: RenderImageInput): Promise<RenderedMedia> {
    input.signal?.throwIfAborted();
    const { card } = input;
    const layers: OverlayOptions[] = [];
    if (input.logoPath && card.brand.logoObjectKey) {
      const box = logoBox(
        card.width,
        card.height,
        card.brand.watermarkPosition,
      );
      const logo = await sharp(input.logoPath, { limitInputPixels: 40_000_000 })
        .resize(box.width, box.height, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer()
        .catch(() => null); // an unreadable logo must not block the post
      if (logo) layers.push({ input: logo, left: box.x, top: box.y });
    }
    const filePath = join(input.workDir, `${input.name}.jpg`);
    await sharp(Buffer.from(renderCardSvg(card)))
      .composite(layers)
      // JPEG: the one image format every platform accepts (Instagram takes nothing else).
      .flatten({ background: card.brand.primaryColor })
      .jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true })
      .toFile(filePath);
    return {
      filePath,
      contentType: 'image/jpeg',
      width: card.width,
      height: card.height,
    };
  }

  async renderCarousel(input: RenderCarouselInput): Promise<RenderedMedia[]> {
    const slides: RenderedMedia[] = [];
    for (const [index, card] of input.cards.entries()) {
      slides.push(
        await this.renderImage({
          ...input,
          card,
          name: `${input.name}-${String(index + 1).padStart(2, '0')}`,
        }),
      );
    }
    return slides;
  }

  async renderVideo(input: RenderVideoInput): Promise<RenderedMedia> {
    const captionsFile = input.captions.length > 0 ? 'captions.ass' : undefined;
    if (captionsFile) {
      await writeFile(
        join(input.workDir, captionsFile),
        buildAssCaptions({
          cues: input.captions,
          width: input.width,
          height: input.height,
          brand: input.brand,
        }),
      );
    }
    const outputPath = join(input.workDir, `${input.name}.mp4`);
    try {
      await runProcess(
        this.ffmpegPath,
        buildClipArgs({
          sourcePath: input.sourcePath,
          outputPath,
          startMs: input.startMs,
          endMs: input.endMs,
          width: input.width,
          height: input.height,
          captionsFile,
          logoPath: input.logoPath,
          watermarkPosition: input.brand.watermarkPosition,
        }),
        {
          timeoutMs: ENCODE_TIMEOUT_MS,
          cwd: input.workDir,
          signal: input.signal,
        },
      );
    } catch (error) {
      input.signal?.throwIfAborted();
      throw new PermanentJobError(
        `ffmpeg clip failed: ${(error as Error).message}`,
        'We could not cut a clip from this sermon video.',
      );
    }
    return {
      filePath: outputPath,
      contentType: 'video/mp4',
      width: input.width,
      height: input.height,
      durationMs: await this.durationMs(outputPath, input.signal),
    };
  }

  async renderThumbnail(input: RenderThumbnailInput): Promise<RenderedMedia> {
    const outputPath = join(input.workDir, `${input.name}.jpg`);
    await runProcess(
      this.ffmpegPath,
      buildThumbnailArgs({
        videoPath: input.videoPath,
        outputPath,
        atMs: input.atMs,
      }),
      { timeoutMs: PROBE_TIMEOUT_MS, signal: input.signal },
    );
    const { width, height } = await sharp(outputPath).metadata();
    return {
      filePath: outputPath,
      contentType: 'image/jpeg',
      width: width ?? 0,
      height: height ?? 0,
    };
  }

  private async durationMs(
    path: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const output = await runProcess(
      this.ffprobePath,
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        '-show_entries',
        'format=duration',
        '-of',
        'json',
        path,
      ],
      { timeoutMs: PROBE_TIMEOUT_MS, signal },
    );
    const parsed = JSON.parse(output) as { format?: { duration?: string } };
    return Math.round(Number(parsed.format?.duration ?? 0) * 1000);
  }
}
