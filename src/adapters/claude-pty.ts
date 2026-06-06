import type { ProcessRunner } from './process-runner.js';
import type { KairoConfig } from '../core/config.js';
import type { ClaudeAdapter, ClaudeInvocation, ClaudeResult } from './claude.js';

/**
 * Minimal surface of node-pty we rely on, so tests can inject a fake and the
 * dependency stays optional.
 */
export interface PtyProcess {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
  write(data: string): void;
  kill(): void;
}

export interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number },
  ): PtyProcess;
}

export type PtyLoader = () => Promise<PtyModule>;

const defaultPtyLoader: PtyLoader = async () => {
  // Dynamic import: node-pty is an optional dependency; installs without it
  // must fail with a clear message at invoke time, not crash at import time.
  const mod = (await import('node-pty')) as unknown as PtyModule;
  return mod;
};

/**
 * Opt-in PTY-backed Claude transport (`claude.transport: "pty"`).
 *
 * Scope (honest): this runs the SAME public print-mode command as the default
 * adapter — just inside a real pseudo-terminal, with output streamed
 * chunk-by-chunk via onChunk. It is a transport foundation, NOT persistent
 * sessions, NOT live message injection, and NOT interactive permission-prompt
 * control.
 *
 * Prompt delivery (validated against Claude Code 2.1.167): `claude --print`
 * refuses to read its prompt from a TTY stdin ("Input must be provided either
 * through stdin or as a prompt argument when using --print"), so the prompt
 * is passed as an argv element. pty.spawn takes an args array — no shell, no
 * quoting concerns — but argv has an OS size limit, so oversized prompts are
 * rejected with guidance to use the print transport.
 *
 * Known PTY behavior, accepted and documented: Claude emits terminal
 * mode-reset/ANSI sequences around its output; the raw transcript keeps them,
 * and report extraction sanitizes its own input.
 */
export class ClaudePtyAdapter implements ClaudeAdapter {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly config: KairoConfig,
    private readonly repoRoot: string,
    private readonly ptyLoader: PtyLoader = defaultPtyLoader,
    private readonly timeoutMs: number = 30 * 60 * 1000,
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.runner.commandExists(this.config.claude.command, this.repoRoot);
  }

  /** Conservative argv budget: macOS ARG_MAX is ~256KB for args+env combined. */
  private static readonly MAX_PROMPT_ARG_BYTES = 180_000;

  async invoke(invocation: ClaudeInvocation): Promise<ClaudeResult> {
    const started = Date.now();

    if (Buffer.byteLength(invocation.prompt, 'utf8') > ClaudePtyAdapter.MAX_PROMPT_ARG_BYTES) {
      return {
        ok: false,
        transcript: '',
        exitCode: null,
        durationMs: Date.now() - started,
        error: `prompt is too large for the PTY transport's argv delivery (${Buffer.byteLength(invocation.prompt, 'utf8')} bytes > ${ClaudePtyAdapter.MAX_PROMPT_ARG_BYTES}) — use claude.transport "print" for this task`,
      };
    }

    let pty: PtyModule;
    try {
      pty = await this.ptyLoader();
    } catch (err) {
      return {
        ok: false,
        transcript: '',
        exitCode: null,
        durationMs: Date.now() - started,
        error: `claude.transport is "pty" but node-pty could not be loaded (${(err as Error).message}). Install the optional node-pty dependency or set claude.transport to "print".`,
      };
    }

    const permissionMode = this.config.claude.permissionMode === 'auto' ? 'acceptEdits' : this.config.claude.permissionMode;
    // Prompt as an argv element — `--print` does not read prompts from a TTY stdin.
    const args = ['-p', invocation.prompt, '--permission-mode', permissionMode, '--model', this.config.claude.model];

    return new Promise<ClaudeResult>((resolve) => {
      let transcript = '';
      let settled = false;
      let proc: PtyProcess | undefined;
      const settle = (result: ClaudeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      // The timeout covers the entire invocation, spawn included.
      const timer = setTimeout(() => {
        try {
          proc?.kill();
        } catch {
          // already dead — nothing to do
        }
        settle({
          ok: false,
          transcript,
          exitCode: null,
          durationMs: Date.now() - started,
          error: `Claude PTY invocation timed out after ${Math.round(this.timeoutMs / 1000)}s`,
        });
      }, this.timeoutMs);

      try {
        proc = pty.spawn(this.config.claude.command, args, {
          cwd: this.repoRoot,
          env: process.env,
          cols: 200,
          rows: 50,
        });
      } catch (err) {
        settle({
          ok: false,
          transcript: '',
          exitCode: null,
          durationMs: Date.now() - started,
          error: `failed to spawn ${this.config.claude.command} in a PTY: ${(err as Error).message}`,
        });
        return;
      }

      proc.onData((chunk) => {
        // node-pty can deliver buffered data between kill() and teardown;
        // after settle the result is final — late chunks must not mutate the
        // transcript or re-enter the caller's onChunk (which may have torn
        // down its write pipeline already).
        if (settled) return;
        transcript += chunk;
        invocation.onChunk?.(chunk);
      });

      proc.onExit(({ exitCode }) => {
        settle({
          ok: exitCode === 0,
          transcript,
          exitCode,
          durationMs: Date.now() - started,
          ...(exitCode === 0 ? {} : { error: `Claude (pty) exited ${exitCode}` }),
        });
      });

      // Nothing is written to the PTY: the prompt travels via argv (see
      // class docs). Stdin stays untouched, so there is no prompt echo and
      // no EOF signaling to get wrong.
    });
  }
}
