import type { ProcessRunner } from './process-runner.js';
import type { KairoConfig } from '../core/config.js';
import { shellQuote } from '../utils/shell.js';

export interface ClaudeInvocation {
  prompt: string;
  purpose: string;
  /** Called with raw output chunks so the orchestrator can stream a transcript to disk. */
  onChunk?: (chunk: string) => void;
  /** Per-call permission mode (e.g. "plan" for head-role calls); defaults to config. */
  permissionModeOverride?: string;
  /** Fired by `kairo stop`: the owned child process is terminated. */
  cancellation?: import('../core/cancellation.js').CancellationSignal;
}

export interface ClaudeResult {
  ok: boolean;
  transcript: string;
  exitCode: number | null;
  durationMs: number;
  error?: string;
  /** True when the invocation was terminated by a user cancellation. */
  cancelled?: boolean;
}

export interface ClaudeAdapter {
  isAvailable(): Promise<boolean>;
  invoke(invocation: ClaudeInvocation): Promise<ClaudeResult>;
}

/**
 * Claude Code CLI adapter — subprocess implementation.
 *
 * KNOWN LIMITATION (documented in docs/limitations.md): this default transport
 * runs Claude in non-interactive print mode (`claude -p`) via a plain
 * subprocess. Interactive permission prompts cannot be answered in this mode,
 * so the permission mode from config is passed through and Claude's own
 * permission system decides what to allow. Output is buffered: onChunk fires
 * once, after completion, with the full transcript. The opt-in PTY transport
 * (claude-pty.ts, `claude.transport: "pty"`) streams chunks as they arrive.
 */
export class ClaudeCliAdapter implements ClaudeAdapter {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly config: KairoConfig,
    private readonly repoRoot: string,
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.runner.commandExists(this.config.claude.command, this.repoRoot);
  }

  async invoke(invocation: ClaudeInvocation): Promise<ClaudeResult> {
    const permissionMode = mapPermissionMode(
      invocation.permissionModeOverride ?? this.config.claude.permissionMode,
    );
    const parts = [
      shellQuote(this.config.claude.command),
      '-p', // print mode: non-interactive, prompt from stdin
      '--permission-mode',
      shellQuote(permissionMode),
      '--model',
      shellQuote(this.config.claude.model),
    ];
    const command = parts.join(' ');

    const run = await this.runner.runShell(command, {
      cwd: this.repoRoot,
      input: invocation.prompt,
      timeoutMs: 30 * 60 * 1000,
      // Composed by Kairo from config + fixed flags; Claude has its own permission system.
      skipSafetyCheck: true,
      ...(invocation.cancellation ? { cancellation: invocation.cancellation } : {}),
    });

    const transcript = [run.stdout, run.stderr ? `\n--- stderr ---\n${run.stderr}` : '']
      .join('')
      .trim();
    invocation.onChunk?.(transcript);

    if (run.cancelled) {
      const reason = (await invocation.cancellation?.reason()) ?? 'no reason recorded';
      return {
        ok: false,
        cancelled: true,
        transcript, // partial output collected before termination
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        error: `cancelled by user: ${reason}`,
      };
    }

    const ok = run.exitCode === 0;
    return {
      ok,
      transcript,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      ...(ok
        ? {}
        : {
            error: run.commandNotFound
              ? `Claude CLI not found (command: ${this.config.claude.command})`
              : `Claude exited ${run.exitCode}${run.timedOut ? ' (timed out)' : ''}`,
          }),
    };
  }
}

/**
 * Config uses "auto" as a friendly default; Claude CLI's actual mode name is
 * "acceptEdits". Pass through anything else verbatim so users can set
 * "plan", "default", etc.
 */
function mapPermissionMode(mode: string): string {
  return mode === 'auto' ? 'acceptEdits' : mode;
}
