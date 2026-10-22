import { spawn } from 'node:child_process';

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command to completion with stdin closed and captures its output.
 * A non-zero exit is reported in the result; only a missing binary or a
 * failed pipe rejects.
 */
export function run(command: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
  });
}

/** Trailing lines of stdout or stderr, which is where ffmpeg explains a failure. */
export function tail(text: string, lines = 12): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}
