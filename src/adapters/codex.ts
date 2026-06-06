import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { ProcessRunner } from './process-runner.js';
import type { KairoConfig } from '../core/config.js';
import { parseDirective, type DirectiveParseResult } from '../core/directives.js';
import { fileExists, readText } from '../utils/fs.js';
import { shellQuote } from '../utils/shell.js';

export interface CodexInvocation {
  prompt: string;
  /** Free-form label for artifacts/logs, e.g. "triage", "review-phase-1". */
  purpose: string;
  /**
   * Sandbox mode for this call. Planning/review calls must pass "read-only";
   * only the dedicated self-edit invocation gets the configured write sandbox.
   * Defaults to the config sandbox when omitted.
   */
  sandbox?: string;
}

export interface CodexResult {
  ok: boolean;
  lastMessage: string;
  rawStdout: string;
  rawStderr: string;
  exitCode: number | null;
  durationMs: number;
  error?: string;
}

export interface CodexAdapter {
  isAvailable(): Promise<boolean>;
  /** Run Codex once with a prompt; returns its final message. */
  invoke(invocation: CodexInvocation): Promise<CodexResult>;
  /** Run Codex and parse a directive from its final message. */
  invokeForDirective(invocation: CodexInvocation): Promise<{
    result: CodexResult;
    parsed: DirectiveParseResult;
  }>;
}

/**
 * Codex CLI adapter. Uses `codex exec` non-interactively with the prompt on
 * stdin and `--output-last-message` to capture the final message reliably.
 *
 * Session persistence note: rather than depending on Codex's own session
 * resume (which varies across versions), Kairo reconstructs context from
 * artifacts (repo-scan.md, master-plan.md, diff.patch, checks.json) in every
 * prompt. Session metadata is still recorded for inspection.
 */
export class CodexCliAdapter implements CodexAdapter {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly config: KairoConfig,
    private readonly repoRoot: string,
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.runner.commandExists(this.config.codex.command, this.repoRoot);
  }

  async invoke(invocation: CodexInvocation): Promise<CodexResult> {
    const outFile = join(tmpdir(), `kairo-codex-${randomBytes(6).toString('hex')}.txt`);
    const parts = [
      shellQuote(this.config.codex.command),
      'exec',
      '--cd',
      shellQuote(this.repoRoot),
      '--sandbox',
      shellQuote(invocation.sandbox ?? this.config.codex.sandbox),
      '--output-last-message',
      shellQuote(outFile),
    ];
    if (this.config.codex.model) {
      parts.push('--model', shellQuote(this.config.codex.model));
    }
    parts.push('-'); // read prompt from stdin
    const command = parts.join(' ');

    const run = await this.runner.runShell(command, {
      cwd: this.repoRoot,
      input: invocation.prompt,
      timeoutMs: 20 * 60 * 1000,
      // Composed by Kairo from config + fixed flags; the sandbox is Codex's own.
      skipSafetyCheck: true,
    });

    let lastMessage = '';
    if (await fileExists(outFile)) {
      lastMessage = (await readText(outFile)).trim();
    }
    if (!lastMessage) {
      // Fall back to stdout if --output-last-message produced nothing.
      lastMessage = run.stdout.trim();
    }

    const ok = run.exitCode === 0 && lastMessage.length > 0;
    return {
      ok,
      lastMessage,
      rawStdout: run.stdout,
      rawStderr: run.stderr,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      ...(ok
        ? {}
        : {
            error: run.commandNotFound
              ? `Codex CLI not found (command: ${this.config.codex.command})`
              : `Codex exited ${run.exitCode}${run.timedOut ? ' (timed out)' : ''}`,
          }),
    };
  }

  async invokeForDirective(invocation: CodexInvocation): Promise<{
    result: CodexResult;
    parsed: DirectiveParseResult;
  }> {
    const result = await this.invoke(invocation);
    const parsed = result.ok
      ? parseDirective(result.lastMessage)
      : { ok: false, rawOutput: result.lastMessage, error: result.error ?? 'Codex invocation failed' };
    return { result, parsed };
  }
}
