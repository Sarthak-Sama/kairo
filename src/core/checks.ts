import type { CheckConfig } from './config.js';
import type { ProcessRunner } from '../adapters/process-runner.js';
import { checkCommandSafety } from './safety.js';

export type CheckStatus = 'passed' | 'failed' | 'skipped' | 'blocked';

export interface CheckResult {
  name: string;
  command: string;
  status: CheckStatus;
  exitCode: number | null;
  durationMs: number;
  /** Why a check was skipped or blocked — honesty over silence. */
  detail?: string;
  outputTail: string;
}

export interface ChecksRun {
  results: CheckResult[];
  passed: number;
  failed: number;
  skipped: number;
  blocked: number;
  allPassedOrSkipped: boolean;
  log: string;
  /** Names in `only` that matched no configured check — surfaced, never silent. */
  unknownOnlyNames: string[];
}

const OUTPUT_TAIL_CHARS = 4000;

/**
 * Run configured checks. Missing tooling/scripts are recorded as `skipped`
 * (not failed); destructive check commands are recorded as `blocked` and never run.
 */
export async function runChecks(
  checks: CheckConfig[],
  runner: ProcessRunner,
  options: { cwd: string; only?: string[]; timeoutMs?: number },
): Promise<ChecksRun> {
  let selected = checks;
  let unknownOnlyNames: string[] = [];
  if (options.only && options.only.length > 0) {
    selected = checks.filter((c) => options.only!.includes(c.name));
    unknownOnlyNames = options.only.filter((n) => !checks.some((c) => c.name === n));
    // A filter that matches nothing must never silently skip verification —
    // (live finding: Codex sent a command string instead of a check name).
    // Fall back to running everything configured.
    if (selected.length === 0) selected = checks;
  }

  const results: CheckResult[] = [];
  const logParts: string[] = [];

  for (const check of selected) {
    const safety = checkCommandSafety(check.command);
    if (!safety.allowed) {
      results.push({
        name: check.name,
        command: check.command,
        status: 'blocked',
        exitCode: null,
        durationMs: 0,
        detail: `blocked by safety gate: ${safety.reason}`,
        outputTail: '',
      });
      logParts.push(`### ${check.name}\nBLOCKED: ${safety.reason}\n`);
      continue;
    }

    const missing = await isCheckUnavailable(check.command, runner, options.cwd);
    if (missing) {
      results.push({
        name: check.name,
        command: check.command,
        status: 'skipped',
        exitCode: null,
        durationMs: 0,
        detail: missing,
        outputTail: '',
      });
      logParts.push(`### ${check.name}\nSKIPPED: ${missing}\n`);
      continue;
    }

    const run = await runner.runShell(check.command, {
      cwd: options.cwd,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });

    // A missing package script (e.g. `pnpm lint` with no lint script) is a
    // skip, not a failure — the project simply doesn't define that check.
    // Only stderr on a non-zero exit counts, so a check whose own test output
    // happens to contain "missing script" text is not misclassified.
    if (run.commandNotFound || (run.exitCode !== 0 && isMissingScript(run.stderr))) {
      results.push({
        name: check.name,
        command: check.command,
        status: 'skipped',
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        detail: 'command or package script not found',
        outputTail: tail(run.stdout + '\n' + run.stderr),
      });
      logParts.push(`### ${check.name}\nSKIPPED: command or script not found\n${tail(run.stderr)}\n`);
      continue;
    }

    const status: CheckStatus = run.exitCode === 0 ? 'passed' : 'failed';
    results.push({
      name: check.name,
      command: check.command,
      status,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      ...(run.timedOut ? { detail: 'timed out' } : {}),
      outputTail: tail(run.stdout + '\n' + run.stderr),
    });
    logParts.push(
      `### ${check.name}\nexit ${run.exitCode} (${run.durationMs}ms)\n\n${tail(run.stdout + '\n' + run.stderr)}\n`,
    );
  }

  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const blocked = results.filter((r) => r.status === 'blocked').length;

  return {
    results,
    passed,
    failed,
    skipped,
    blocked,
    allPassedOrSkipped: failed === 0 && blocked === 0,
    log: logParts.join('\n'),
    unknownOnlyNames,
  };
}

/** Pre-flight: if the binary itself (first word) is missing, skip without running. */
async function isCheckUnavailable(
  command: string,
  runner: ProcessRunner,
  cwd: string,
): Promise<string | null> {
  const binary = command.trim().split(/\s+/)[0];
  if (!binary) return 'empty command';
  const exists = await runner.commandExists(binary, cwd);
  return exists ? null : `\`${binary}\` is not installed or not on PATH`;
}

function isMissingScript(output: string): boolean {
  return /Missing script|missing script:|Command "[^"]+" not found|ERR_PNPM_NO_SCRIPT/i.test(output);
}

function tail(text: string, chars = OUTPUT_TAIL_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length <= chars ? trimmed : '…' + trimmed.slice(-chars);
}
