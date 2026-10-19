import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PermanentJobError } from '../../../shared/application/jobs.js';
import type {
  MediaProcessorPort,
  PreparedMedia,
} from './ports.js';

const CHUNK_SECONDS = 20 * 60; // mono 16 kHz @ 32 kbps ≈ 4.8 MB per chunk, well under provider upload limits
const PROCESS_TIMEOUT_MS = 30 * 60 * 1000;

interface ProbeResult {
  format?: { duration?: string };
  streams?: Array<{ codec_type?: string }>;
}

/** Uses ffmpeg/ffprobe binaries on disk; media never passes through process memory. */
export class FfmpegMediaProcessor implements MediaProcessorPort {
  constructor(
    private readonly ffmpegPath: string,
    private readonly ffprobePath: string,
  ) {}

  async prepareForTranscription(
    inputPath: string,
    workDir: string,
    signal?: AbortSignal,
  ): Promise<PreparedMedia> {
    const probe = await this.probe(inputPath, signal).catch(() => {
      throw new PermanentJobError(
        'ffprobe could not read media',
        'We could not read this file. Check that it plays correctly and try again.',
      );
    });
    if (!probe.streams?.some((stream) => stream.codec_type === 'audio')) {
      throw new PermanentJobError(
        'No audio stream',
        'This file has no audio we can transcribe.',
      );
    }
    const outputPattern = join(workDir, 'chunk-%03d.mp3');
    await run(
      this.ffmpegPath,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-protocol_whitelist',
        'file',
        '-i',
        inputPath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '32k',
        '-f',
        'segment',
        '-segment_time',
        String(CHUNK_SECONDS),
        '-reset_timestamps',
        '1',
        outputPattern,
      ],
      signal,
    );
    const files = (await readdir(workDir))
      .filter((name) => /^chunk-\d{3}\.mp3$/.test(name))
      .sort();
    if (files.length === 0)
      throw new PermanentJobError(
        'ffmpeg produced no audio',
        'We could not extract audio from this file.',
      );

    const chunks: PreparedMedia['chunks'] = [];
    let offsetMs = 0;
    for (const file of files) {
      const path = join(workDir, file);
      const durationMs = Math.round(
        Number((await this.probe(path, signal)).format?.duration ?? 0) * 1000,
      );
      chunks.push({ path, offsetMs, durationMs });
      offsetMs += durationMs;
    }
    return { durationMs: offsetMs, chunks };
  }

  private async probe(
    path: string,
    signal?: AbortSignal,
  ): Promise<ProbeResult> {
    const output = await run(
      this.ffprobePath,
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        '-show_entries',
        'format=duration:stream=codec_type',
        '-of',
        'json',
        path,
      ],
      signal,
    );
    return JSON.parse(output) as ProbeResult;
  }
}

function run(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // `signal` kills the child process when the job is aborted.
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
      killSignal: 'SIGKILL',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000); // bounded
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), PROCESS_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else
        reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
    });
  });
}
