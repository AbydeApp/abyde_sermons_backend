import type { BrandSnapshot } from './brand-profile.js';
import type { CaptionCue } from './captions.js';

/** Stored on a pending asset: exactly what the worker must render. Contains no secrets. */
export type RenderSpec =
  | {
      type: 'card';
      templateId: string;
      width: number;
      height: number;
      heading?: string;
      text: string;
      attribution?: string;
      pageLabel?: string;
      brand: BrandSnapshot;
    }
  | {
      type: 'video';
      templateId: string;
      /** Private source sermon media; only ever read by the worker. */
      sourceObjectKey: string;
      startMs: number;
      endMs: number;
      width: number;
      height: number;
      captions: CaptionCue[];
      brand: BrandSnapshot;
    }
  | {
      type: 'thumbnail';
      /** The rendered video (same render group) the frame is taken from. */
      videoAssetId: string;
      atMs: number;
    };

export function isRenderSpec(value: unknown): value is RenderSpec {
  const type = (value as { type?: unknown } | null)?.type;
  return type === 'card' || type === 'video' || type === 'thumbnail';
}
