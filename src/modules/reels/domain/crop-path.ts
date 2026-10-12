/** Where the speaker is at one moment: horizontal centre as a fraction of the frame width. */
export interface TrackingSample {
  /** Milliseconds from the start of the clip. */
  tMs: number;
  /** 0 = left edge, 1 = right edge. */
  cx: number;
  /** 0–1; low-confidence samples are ignored. */
  confidence: number;
}

export interface CropKeyframe {
  tMs: number;
  /** Left edge of the crop window in source pixels. */
  x: number;
}

/** A vertical window moving across a landscape frame; x is interpolated linearly between keyframes. */
export interface CropPlan {
  cropWidth: number;
  cropHeight: number;
  keyframes: CropKeyframe[];
}

const GRID_MS = 250;
const MIN_CONFIDENCE = 0.5;
/** A sample is used for grid points this close to it; further away the camera holds. */
const SAMPLE_REACH_MS = 1_000;
/** The camera ignores movement inside this band (fraction of crop width): no jitter on gestures. */
const DEAD_ZONE = 0.12;
/** Fastest pan, in crop widths per second: follows a walking preacher without whip pans. */
const MAX_PAN_PER_SECOND = 0.35;
/** Keyframes closer than this to the straight line between their neighbours are dropped. */
const SIMPLIFY_TOLERANCE_PX = 4;
export const MAX_KEYFRAMES = 120;

const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** Ramer–Douglas–Peucker on (t, x): keeps the shape of the camera move with few keyframes. */
function simplify(points: CropKeyframe[], tolerance: number): CropKeyframe[] {
  if (points.length <= 2) return points;
  const first = points[0] as CropKeyframe;
  const last = points[points.length - 1] as CropKeyframe;
  let worst = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const point = points[i] as CropKeyframe;
    const span = last.tMs - first.tMs || 1;
    const expected =
      first.x + ((last.x - first.x) * (point.tMs - first.tMs)) / span;
    const distance = Math.abs(point.x - expected);
    if (distance > worst) {
      worst = distance;
      index = i;
    }
  }
  if (worst <= tolerance) return [first, last];
  return [
    ...simplify(points.slice(0, index + 1), tolerance).slice(0, -1),
    ...simplify(points.slice(index), tolerance),
  ];
}

/**
 * Plans a smooth 9:16 crop across a wider source so the speaker stays in frame.
 *
 * Detection samples are noisy (gestures, other faces, missed frames), so the path is built like a
 * camera operator would: fill gaps by holding, median-filter outliers, ignore small movement
 * (dead zone), cap the pan speed, then reduce to a few keyframes. With no usable samples the crop
 * is a steady centre frame. Returns null when the source is already as narrow as the target, in
 * which case the renderer fits the whole frame instead of cropping.
 */
export function planCropPath(input: {
  samples: TrackingSample[];
  sourceWidth: number;
  sourceHeight: number;
  durationMs: number;
  aspect?: { width: number; height: number };
}): CropPlan | null {
  const aspect = input.aspect ?? { width: 9, height: 16 };
  const cropHeight = even(input.sourceHeight);
  const cropWidth = even((cropHeight * aspect.width) / aspect.height);
  if (cropWidth >= input.sourceWidth) return null;
  const maxX = input.sourceWidth - cropWidth;
  const centreX = input.sourceWidth / 2;
  const toX = (centre: number) =>
    Math.round(Math.min(maxX, Math.max(0, centre - cropWidth / 2)));

  const usable = input.samples
    .filter(
      (sample) =>
        sample.confidence >= MIN_CONFIDENCE &&
        Number.isFinite(sample.cx) &&
        sample.tMs >= -SAMPLE_REACH_MS &&
        sample.tMs <= input.durationMs + SAMPLE_REACH_MS,
    )
    .map((sample) => ({
      tMs: sample.tMs,
      px: Math.min(1, Math.max(0, sample.cx)) * input.sourceWidth,
    }))
    .sort((a, b) => a.tMs - b.tMs);
  const duration = Math.max(0, input.durationMs);
  if (usable.length === 0)
    return { cropWidth, cropHeight, keyframes: [{ tMs: 0, x: toX(centreX) }] };

  // 1. Target on a fixed grid: the nearest sample within reach, otherwise hold the last target.
  const grid: number[] = [];
  let held = (usable[0] as { px: number }).px;
  let cursor = 0;
  for (let t = 0; t <= duration; t += GRID_MS) {
    while (
      cursor + 1 < usable.length &&
      Math.abs((usable[cursor + 1] as { tMs: number }).tMs - t) <=
        Math.abs((usable[cursor] as { tMs: number }).tMs - t)
    )
      cursor += 1;
    const nearest = usable[cursor] as { tMs: number; px: number };
    if (Math.abs(nearest.tMs - t) <= SAMPLE_REACH_MS) held = nearest.px;
    grid.push(held);
  }

  // 2. Median filter removes single-sample spikes (a raised hand, a face in the front row).
  const filtered = grid.map((_, i) =>
    median(grid.slice(Math.max(0, i - 2), Math.min(grid.length, i + 3))),
  );

  // 3. Dead-zone camera with a pan-speed limit.
  const deadZone = DEAD_ZONE * cropWidth;
  const maxStep = MAX_PAN_PER_SECOND * cropWidth * (GRID_MS / 1000);
  let camera = filtered[0] as number;
  const path: CropKeyframe[] = filtered.map((target, i) => {
    const offset = target - camera;
    if (Math.abs(offset) > deadZone) {
      const wanted = offset - Math.sign(offset) * deadZone;
      camera += Math.sign(wanted) * Math.min(Math.abs(wanted), maxStep);
    }
    return { tMs: i * GRID_MS, x: toX(camera) };
  });

  // 4. Few keyframes; tolerance grows until the expression the renderer builds stays small.
  let tolerance = SIMPLIFY_TOLERANCE_PX;
  let keyframes = simplify(path, tolerance);
  while (keyframes.length > MAX_KEYFRAMES) {
    tolerance *= 2;
    keyframes = simplify(path, tolerance);
  }
  if (keyframes.every((frame) => frame.x === keyframes[0]?.x))
    keyframes = keyframes.slice(0, 1);
  return { cropWidth, cropHeight, keyframes };
}
