import { execa, type Options as ExecaOptions } from 'execa';
import { assertCommandSafe } from '../core/safety.js';
import { shellQuote } from '../utils/shell.js';

export interface RunResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  failed: boolean;
  timedOut: boolean;
  commandNotFound: boolean;
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  input?: string;
  env?: Record<string, string>;
  /** Skip the destructive-pattern gate. Only for commands Kairo itself composed. */
  skipSafetyCheck?: boolean;
}

export interface ProcessRunner {
  runShell(command: string, options: RunOptions): Promise<RunResult>;
  commandExists(command: string, cwd: string): Promise<boolean>;
}

/**
 * Single choke-point for everything Kairo executes. Every shell command passes
 * the destructive-command gate unless explicitly exempted (used only for
 * Kairo-composed read-only git commands).
 */
export class ExecaProcessRunner implements ProcessRunner {
  async runShell(command: string, options: RunOptions): Promise<RunResult> {
    if (!options.skipSafetyCheck) {
      assertCommandSafe(command);
    }
    const started = Date.now();
    const execaOptions: ExecaOptions = {
      cwd: options.cwd,
      shell: true,
      reject: false,
      timeout: options.timeoutMs ?? 10 * 60 * 1000,
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
      all: false,
    };
    const result = await execa(command, execaOptions);
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    return {
      command,
      exitCode: result.exitCode ?? null,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr,
      durationMs: Date.now() - started,
      failed: result.failed ?? false,
      timedOut: result.timedOut ?? false,
      commandNotFound: detectCommandNotFound(result.exitCode ?? null, stderr),
    };
  }

  async commandExists(command: string, cwd: string): Promise<boolean> {
    // `command` comes from user config — quote it (POSIX) or pass it as an
    // argv element (Windows) so it can never be interpreted as shell syntax.
    if (process.platform === 'win32') {
      const result = await execa('where', [command], { reject: false, cwd });
      return result.exitCode === 0;
    }
    const result = await execa(`command -v ${shellQuote(command)}`, {
      shell: true,
      reject: false,
      cwd,
    });
    return result.exitCode === 0;
  }
}

function detectCommandNotFound(exitCode: number | null, stderr: string): boolean {
  if (exitCode === 127) return true;
  return /command not found|not recognized as an internal or external command|No such file or directory/i.test(
    stderr,
  );
}
