import type { WatermarkPosition } from '../../domain/brand-profile.js';

export interface ClipArgsInput {
  sourcePath: string;
  outputPath: string;
  startMs: number;
  endMs: number;
  width: number;
  height: number;
  /** File name of the ASS captions inside the working directory (ffmpeg runs with that cwd). */
  captionsFile?: string;
  logoPath?: string;
  watermarkPosition: WatermarkPosition;
}

const seconds = (ms: number) => (ms / 1000).toFixed(3);

/**
 * ffmpeg arguments for a vertical branded clip:
 * 1. cut the window (input seek, re-encoded so the cut is exact),
 * 2. fill the frame with a blurred, scaled copy and centre the original on top (works for
 *    landscape and portrait sources alike),
 * 3. burn in captions, 4. stamp the logo, 5. H.264/AAC MP4 with faststart for streaming.
 */
export function buildClipArgs(input: ClipArgsInput): string[] {
  const { width: W, height: H } = input;
  const logoSize = Math.round(W * 0.14);
  const margin = Math.round(W * 0.06);
  const filters = [
    `[0:v]split=2[bgsrc][fgsrc]`,
    `[bgsrc]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:2,eq=brightness=-0.08[bg]`,
    `[fgsrc]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30[base]`,
  ];
  let current = 'base';
  if (input.captionsFile) {
    filters.push(`[${current}]subtitles=${input.captionsFile}[captioned]`);
    current = 'captioned';
  }
  if (input.logoPath) {
    const x = input.watermarkPosition.endsWith('left')
      ? `${margin}`
      : `W-w-${margin}`;
    const y = input.watermarkPosition.startsWith('top')
      ? `${margin}`
      : `H-h-${margin}`;
    filters.push(
      `[1:v]scale=${logoSize}:${logoSize}:force_original_aspect_ratio=decrease,format=rgba,colorchannelmixer=aa=0.9[logo]`,
      `[${current}][logo]overlay=${x}:${y}[branded]`,
    );
    current = 'branded';
  }
  filters.push(`[${current}]format=yuv420p[out]`);
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-protocol_whitelist',
    'file',
    '-ss',
    seconds(input.startMs),
    '-t',
    seconds(input.endMs - input.startMs),
    '-i',
    input.sourcePath,
    ...(input.logoPath ? ['-i', input.logoPath] : []),
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[out]',
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '22',
    '-profile:v',
    'high',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '48000',
    '-movflags',
    '+faststart',
    input.outputPath,
  ];
}

export function buildThumbnailArgs(input: {
  videoPath: string;
  outputPath: string;
  atMs: number;
}): string[] {
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-protocol_whitelist',
    'file',
    '-ss',
    seconds(input.atMs),
    '-i',
    input.videoPath,
    '-frames:v',
    '1',
    '-q:v',
    '3',
    input.outputPath,
  ];
}
