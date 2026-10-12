import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { runProcess } from '../../../../shared/infrastructure/process/run-process.js';
import type {
  SpeakerTrackingPort,
  TrackingResult,
} from '../../application/ports/out/reel.ports.js';
import { CenterSpeakerTracker } from './center-speaker-tracker.js';

const Output = z.object({
  samples: z
    .array(
      z.object({
        t: z.number(),
        cx: z.number(),
        confidence: z.number(),
      }),
    )
    .max(20_000),
});

export interface CommandTrackerOptions {
  /** Executable and fixed arguments, e.g. `python3 /app/scripts/speaker-tracking/track_speaker.py`. */
  command: string;
  timeoutMs: number;
  /** Frames analysed per second of video. */
  sampleFps: number;
}

/**
 * Runs an external speaker-tracking program (the bundled MediaPipe/OpenCV script, or any program
 * honouring the same JSON contract). Arguments are passed without a shell. If the program fails,
 * times out or prints something unexpected, the Reel still renders with a centre crop.
 */
export class CommandSpeakerTracker implements SpeakerTrackingPort {
  private readonly logger = new Logger(CommandSpeakerTracker.name);
  private readonly fallback = new CenterSpeakerTracker();

  constructor(private readonly options: CommandTrackerOptions) {}

  async analyze(input: {
    videoPath: string;
    startMs: number;
    endMs: number;
    signal?: AbortSignal;
  }): Promise<TrackingResult> {
    const [command, ...fixed] = this.options.command
      .split(/\s+/)
      .filter(Boolean);
    if (!command) return this.fallback.analyze();
    try {
      const stdout = await runProcess(
        command,
        [
          ...fixed,
          '--video',
          input.videoPath,
          '--start',
          (input.startMs / 1000).toFixed(3),
          '--end',
          (input.endMs / 1000).toFixed(3),
          '--fps',
          String(this.options.sampleFps),
        ],
        { timeoutMs: this.options.timeoutMs, signal: input.signal },
      );
      const parsed = Output.parse(JSON.parse(stdout));
      return {
        provider: 'command',
        samples: parsed.samples.map((sample) => ({
          tMs: Math.round(sample.t * 1000),
          cx: sample.cx,
          confidence: sample.confidence,
        })),
      };
    } catch (error) {
      input.signal?.throwIfAborted();
      this.logger.warn(
        { err: error },
        'Speaker tracking failed; using a centre crop',
      );
      return this.fallback.analyze();
    }
  }
}
