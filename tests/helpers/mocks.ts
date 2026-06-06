import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodexAdapter, CodexInvocation, CodexResult } from '../../src/adapters/codex.js';
import type { ClaudeAdapter, ClaudeInvocation, ClaudeResult } from '../../src/adapters/claude.js';
import type { ProcessRunner, RunOptions, RunResult } from '../../src/adapters/process-runner.js';
import { parseDirective } from '../../src/core/directives.js';
import { assertCommandSafe } from '../../src/core/safety.js';
import type { Directive } from '../../src/core/directives.js';

export async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kairo-test-'));
}

export async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Scripted Codex: returns queued responses in order. */
export class MockCodexAdapter implements CodexAdapter {
  invocations: CodexInvocation[] = [];
  private queue: string[] = [];

  enqueueDirective(directive: Partial<Directive> & { action: Directive['action'] }, prose = ''): void {
    const full: Directive = {
      actor: 'codex',
      requiresUserInput: false,
      risk: 'low',
      reason: 'mock reason',
      successCriteria: [],
      checksToRun: [],
      ...directive,
    };
    this.queue.push(`${prose}\n\`\`\`json\n${JSON.stringify(full, null, 2)}\n\`\`\``);
  }

  enqueueRaw(output: string): void {
    this.queue.push(output);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async invoke(invocation: CodexInvocation): Promise<CodexResult> {
    this.invocations.push(invocation);
    const message = this.queue.shift();
    if (message === undefined) {
      return {
        ok: false,
        lastMessage: '',
        rawStdout: '',
        rawStderr: '',
        exitCode: 1,
        durationMs: 1,
        error: 'mock queue empty',
      };
    }
    return { ok: true, lastMessage: message, rawStdout: message, rawStderr: '', exitCode: 0, durationMs: 1 };
  }

  async invokeForDirective(invocation: CodexInvocation) {
    const result = await this.invoke(invocation);
    const parsed = result.ok
      ? parseDirective(result.lastMessage)
      : { ok: false, rawOutput: '', error: result.error ?? 'failed' };
    return { result, parsed };
  }
}

/** Scripted Claude: returns queued transcripts; can run a side-effect (e.g. write a file). */
export class MockClaudeAdapter implements ClaudeAdapter {
  invocations: ClaudeInvocation[] = [];
  /** Toggle to simulate a missing Claude CLI. */
  available = true;
  /** How many times the orchestrator probed availability. */
  availabilityChecks = 0;
  private queue: Array<{ transcript: string; ok: boolean; sideEffect?: () => Promise<void> }> = [];

  enqueue(transcript: string, opts: { ok?: boolean; sideEffect?: () => Promise<void> } = {}): void {
    this.queue.push({
      transcript,
      ok: opts.ok ?? true,
      ...(opts.sideEffect ? { sideEffect: opts.sideEffect } : {}),
    });
  }

  enqueueReport(phase: number, body: { files?: string[]; complete?: boolean } = {}): void {
    const files = body.files ?? ['src/example.ts'];
    this.enqueue(
      `Working on it...\n\n# Phase ${phase} Report\n## Changed Files\n${files.map((f) => `- ${f}`).join('\n')}\n## Commands Run\n- (none)\n## Risks\nnone\n## Phase Complete\n${body.complete === false ? 'no' : 'yes'} — done`,
    );
  }

  async isAvailable(): Promise<boolean> {
    this.availabilityChecks++;
    return this.available;
  }

  async invoke(invocation: ClaudeInvocation): Promise<ClaudeResult> {
    this.invocations.push(invocation);
    const next = this.queue.shift();
    if (!next) {
      return { ok: false, transcript: '', exitCode: 1, durationMs: 1, error: 'mock queue empty' };
    }
    if (next.sideEffect) await next.sideEffect();
    invocation.onChunk?.(next.transcript);
    return {
      ok: next.ok,
      transcript: next.transcript,
      exitCode: next.ok ? 0 : 1,
      durationMs: 1,
      ...(next.ok ? {} : { error: 'mock failure' }),
    };
  }
}

/**
 * Scripted process runner. Git commands get sensible defaults; check commands
 * can be scripted per-pattern. Still enforces the safety gate like the real one.
 */
export class MockProcessRunner implements ProcessRunner {
  commands: string[] = [];
  private rules: Array<{ pattern: RegExp; results: Partial<RunResult>[]; index: number }> = [];
  missingBinaries = new Set<string>();

  /**
   * Script a result for matching commands. Pass an array to return results
   * sequentially per call (the last one sticks) — e.g. clean git status at
   * baseline, dirty after the implementation step.
   */
  on(pattern: RegExp, result: Partial<RunResult> | Partial<RunResult>[]): void {
    this.rules.push({ pattern, results: Array.isArray(result) ? result : [result], index: 0 });
  }

  async runShell(command: string, options: RunOptions): Promise<RunResult> {
    if (!options.skipSafetyCheck) {
      assertCommandSafe(command);
    }
    this.commands.push(command);
    const base: RunResult = {
      command,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1,
      failed: false,
      timedOut: false,
      commandNotFound: false,
    };
    for (const rule of this.rules) {
      if (rule.pattern.test(command)) {
        const result = rule.results[Math.min(rule.index, rule.results.length - 1)]!;
        rule.index++;
        return { ...base, ...result };
      }
    }
    // Default git behaviors: pretend to be a clean git repo.
    if (command.includes('rev-parse --is-inside-work-tree')) return { ...base, stdout: 'true' };
    if (command.includes('rev-parse HEAD')) return { ...base, stdout: 'abc123def456' };
    if (command.includes('--abbrev-ref')) return { ...base, stdout: 'main' };
    if (command.includes('status --porcelain')) return { ...base, stdout: '' };
    if (command.startsWith('git diff')) return { ...base, stdout: '' };
    return base;
  }

  async commandExists(command: string): Promise<boolean> {
    return !this.missingBinaries.has(command);
  }
}
