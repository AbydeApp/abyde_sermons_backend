import { spawn } from 'node:child_process';

export interface RunProcessOptions {
  /** The process is killed (SIGKILL) after this long. */
  timeoutMs: number;
  cwd?: string;
  /** Aborting kills the process, so a cancelled job does not leave an encode running. */
  signal?: AbortSignal;
}

/** Runs a binary to completion and returns stdout. stderr is kept bounded for the error message. */
export function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error(`${command} aborted before start`));
      return;
    }
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: options.cwd,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000); // bounded
    });
    const kill = () => child.kill('SIGKILL');
    const timer = setTimeout(kill, options.timeoutMs);
    options.signal?.addEventListener('abort', kill, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', kill);
    };
    child.on('error', (error) => {
      cleanup();
      reject(error);
    });
    child.on('close', (code) => {
      cleanup();
      if (code === 0) resolve(stdout);
      else
        reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
    });
  });
}
