import type { LogoPosition } from '../../../brand/domain/video-settings.js';
import type { CropPlan } from '../../domain/crop-path.js';

export interface ReelArgsInput {
  sourcePath: string;
  outputPath: string;
  startMs: number;
  endMs: number;
  width: number;
  height: number;
  sourceHeight: number;
  hasAudio: boolean;
  /** Null: fit the whole frame over a blurred fill (vertical or near-vertical sources). */
  crop: CropPlan | null;
  /** File name of the ASS overlay inside the working directory (ffmpeg runs with that cwd). */
  assFile?: string;
  logoPath?: string;
  logoPosition: LogoPosition;
  /** 0 = no outro card. */
  outroMs: number;
  outroColor: string;
}

const seconds = (ms: number) => (ms / 1000).toFixed(3);
const FPS = 30;
const AUDIO_FORMAT =
  'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';

/**
 * Piecewise-linear x(t) for the crop filter from the planned keyframes. Built as a sum of gated
 * segments (no nesting), so long camera paths stay within ffmpeg's expression parser limits.
 */
export function cropXExpression(plan: CropPlan): string {
  const frames = plan.keyframes;
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (!first || !last) return '0';
  if (frames.length === 1) return String(first.x);
  const terms = [`lt(t,${seconds(first.tMs)})*${first.x}`];
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i] as { tMs: number; x: number };
    const b = frames[i + 1] as { tMs: number; x: number };
    if (b.tMs <= a.tMs) continue;
    const t0 = seconds(a.tMs);
    const span = ((b.tMs - a.tMs) / 1000).toFixed(3);
    terms.push(
      `gte(t,${t0})*lt(t,${seconds(b.tMs)})*(${a.x}+(${b.x - a.x})*(t-${t0})/${span})`,
    );
  }
  terms.push(`gte(t,${seconds(last.tMs)})*${last.x}`);
  return terms.join('+');
}

/**
 * ffmpeg arguments for a finished Reel, in one encode:
 * 1. cut the moment (input seek, re-encoded so the cut is exact),
 * 2. follow the speaker with a moving 9:16 crop, or fit a vertical source over a blurred fill,
 * 3. clean up the real sermon audio only (high-pass, light noise reduction, gentle speech
 *    compression, loudness normalised to -14 LUFS); the voice itself is never altered or replaced,
 * 4. append the branded outro card (silent), 5. burn in hook, captions, labels and outro text,
 * 6. stamp the logo (small during the moment, large on the outro), 7. H.264/AAC with faststart.
 */
export function buildReelArgs(input: ReelArgsInput): string[] {
  const { width: W, height: H } = input;
  const clip = seconds(input.endMs - input.startMs);
  const filters: string[] = [];

  if (input.crop) {
    const y = Math.max(
      0,
      Math.floor((input.sourceHeight - input.crop.cropHeight) / 2),
    );
    filters.push(
      `[0:v]crop=w=${input.crop.cropWidth}:h=${input.crop.cropHeight}:x='${cropXExpression(input.crop)}':y=${y},scale=${W}:${H},setsar=1,fps=${FPS},format=yuv420p[main]`,
    );
  } else {
    filters.push(
      `[0:v]split=2[bgsrc][fgsrc]`,
      `[bgsrc]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:2,eq=brightness=-0.08[bg]`,
      `[fgsrc]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=${FPS},format=yuv420p[main]`,
    );
  }
  filters.push(
    input.hasAudio
      ? `[0:a]highpass=f=70,afftdn=nr=8:nf=-45,acompressor=threshold=-21dB:ratio=2.5:attack=15:release=250:makeup=2,loudnorm=I=-14:TP=-1.5:LRA=11,${AUDIO_FORMAT}[amain]`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${clip},${AUDIO_FORMAT}[amain]`,
  );

  let video = 'main';
  let audio = 'amain';
  if (input.outroMs > 0) {
    const outro = seconds(input.outroMs);
    const colour = input.outroColor.replace('#', '0x');
    filters.push(
      `color=c=${colour}:s=${W}x${H}:r=${FPS}:d=${outro},format=yuv420p,setsar=1[ovid]`,
      `anullsrc=r=48000:cl=stereo,atrim=duration=${outro},${AUDIO_FORMAT}[oaud]`,
      `[main][amain][ovid][oaud]concat=n=2:v=1:a=1[joined][ajoined]`,
    );
    video = 'joined';
    audio = 'ajoined';
  }
  if (input.assFile) {
    filters.push(`[${video}]subtitles=${input.assFile}[subbed]`);
    video = 'subbed';
  }
  if (input.logoPath) {
    const small = Math.round(W * 0.14);
    const big = Math.round(W * 0.3);
    const margin = Math.round(W * 0.06);
    const showSmall = input.logoPosition !== 'none';
    const showBig = input.outroMs > 0;
    if (showSmall || showBig) {
      const outputs = [showSmall ? '[lgs]' : '', showBig ? '[lgb]' : ''].join(
        '',
      );
      filters.push(
        `[1:v]format=rgba,split=${showSmall && showBig ? 2 : 1}${outputs}`,
      );
      if (showSmall) {
        const x = input.logoPosition.endsWith('left')
          ? `${margin}`
          : `W-w-${margin}`;
        const y = input.logoPosition.startsWith('top')
          ? `${margin}`
          : `H-h-${margin}`;
        filters.push(
          `[lgs]scale=${small}:${small}:force_original_aspect_ratio=decrease,colorchannelmixer=aa=0.92[logosmall]`,
          `[${video}][logosmall]overlay=${x}:${y}:enable='lt(t,${clip})'[withlogo]`,
        );
        video = 'withlogo';
      }
      if (showBig) {
        filters.push(
          `[lgb]scale=${big}:${big}:force_original_aspect_ratio=decrease[logobig]`,
          `[${video}][logobig]overlay=(W-w)/2:H*0.42-h:enable='gte(t,${clip})'[withoutro]`,
        );
        video = 'withoutro';
      }
    }
  }
  filters.push(`[${video}]format=yuv420p[vout]`);

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
    clip,
    '-i',
    input.sourcePath,
    ...(input.logoPath ? ['-i', input.logoPath] : []),
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
    '-map',
    `[${audio}]`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '21',
    '-profile:v',
    'high',
    '-r',
    String(FPS),
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-ar',
    '48000',
    '-movflags',
    '+faststart',
    input.outputPath,
  ];
}
