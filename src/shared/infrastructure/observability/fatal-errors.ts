import { reportError } from './error-reporter.js';

/**
 * Unhandled rejections and uncaught exceptions end the process (never swallowed). The error is
 * written as one structured log line with its stack first, so the restart is explainable.
 */
export function crashOnFatalErrors(): void {
  const crash = (kind: string) => (error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error));
    process.stderr.write(
      `${JSON.stringify({ level: 60, time: Date.now(), msg: kind, err: { type: err.name, message: err.message, stack: err.stack } })}\n`,
    );
    reportError(err, { kind });
    process.exit(1);
  };
  process.on('unhandledRejection', crash('Unhandled promise rejection'));
  process.on('uncaughtException', crash('Uncaught exception'));
}
