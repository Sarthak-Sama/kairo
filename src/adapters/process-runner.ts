import { execa, type Options as ExecaOptions } from 'execa';
import { assertCommandSafe } from '../core/safety.js';
import type { CancellationSignal } from '../core/cancellation.js';
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
  /** True when the run was terminated by a user cancellation signal. */
  cancelled?: boolean;
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  input?: string;
  env?: Record<string, string>;
  /** Skip the destructive-pattern gate. Only for commands Kairo itself composed. */
  skipSafetyCheck?: boolean;
  /**
   * Polled while the child runs; when it fires, the OWNED child process is
   * terminated and the result returns `cancelled: true` with whatever output
   * was collected. Never searches or kills anything Kairo did not spawn.
   */
  cancellation?: CancellationSignal;
  /** Cancellation poll interval; small in tests. */
  cancellationPollMs?: number;
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
    // When cancellable, run the child as its own process GROUP leader so a
    // cancellation can terminate the shell AND its descendants (a killed
    // shell otherwise leaves grandchildren holding the stdio pipes, hanging
    // the await). This is still strictly Kairo-owned: only the group Kairo
    // itself spawned is signalled — never a name search, never global.
    const child = execa(command, {
      ...execaOptions,
      ...(options.cancellation ? { detached: true } : {}),
    });

    // Cancellation polling: terminate the OWNED child when the signal fires.
    let cancelled = false;
    let pollTimer: NodeJS.Timeout | undefined;
    const killOwnedTree = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal); // our own group
        else child.kill(signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already dead — nothing to do
        }
      }
    };
    if (options.cancellation) {
      const pollMs = options.cancellationPollMs ?? 300;
      const poll = async () => {
        try {
          if (await options.cancellation!.isCancellationRequested()) {
            cancelled = true;
            killOwnedTree('SIGTERM');
            // escalate if something ignores SIGTERM
            setTimeout(() => {
              if (cancelled) killOwnedTree('SIGKILL');
            }, 2000).unref();
            return;
          }
        } catch {
          // a broken signal must never crash the run
        }
        pollTimer = setTimeout(poll, pollMs);
      };
      pollTimer = setTimeout(poll, pollMs);
    }

    const result = await child;
    if (pollTimer) clearTimeout(pollTimer);
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
      ...(cancelled ? { cancelled: true } : {}),
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
