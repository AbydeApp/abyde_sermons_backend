import type { MediaAssetView } from '../../application/media-presenter.js';
import type { RenderAccepted } from '../../application/use-cases/render.use-cases.js';

export const toMediaAssetResponse = (view: MediaAssetView) => ({
  ...view,
  createdAt: view.createdAt.toISOString(),
});

export const toRenderAcceptedResponse = (
  accepted: RenderAccepted,
  views: MediaAssetView[],
) => ({
  renderGroupId: accepted.renderGroupId,
  status: 'rendering' as const,
  assets: views.map(toMediaAssetResponse),
});
