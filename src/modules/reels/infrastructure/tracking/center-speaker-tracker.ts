import type {
  SpeakerTrackingPort,
  TrackingResult,
} from '../../application/ports/out/reel.ports.js';

/** No detection: the crop planner then holds a steady centre frame. Default and fallback. */
export class CenterSpeakerTracker implements SpeakerTrackingPort {
  async analyze(): Promise<TrackingResult> {
    return { provider: 'center', samples: [] };
  }
}
