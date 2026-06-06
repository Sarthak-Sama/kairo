import { describe, it, expect } from 'vitest';
import { runChecks } from '../../src/core/checks.js';
import { MockProcessRunner } from '../helpers/mocks.js';

const CHECKS = [
  { name: 'typecheck', command: 'pnpm typecheck' },
  { name: 'lint', command: 'pnpm lint' },
  { name: 'test', command: 'pnpm test' },
];

describe('checks runner', () => {
  it('records passing checks', async () => {
    const runner = new MockProcessRunner();
    const run = await runChecks(CHECKS, runner, { cwd: '/repo' });
    expect(run.passed).toBe(3);
    expect(run.failed).toBe(0);
    expect(run.allPassedOrSkipped).toBe(true);
  });

  it('records failing checks with exit codes and output tail', async () => {
    const runner = new MockProcessRunner();
    runner.on(/pnpm test/, { exitCode: 1, stdout: 'FAIL src/x.test.ts\n2 failed', failed: true });
    const run = await runChecks(CHECKS, runner, { cwd: '/repo' });
    expect(run.failed).toBe(1);
    expect(run.allPassedOrSkipped).toBe(false);
    const test = run.results.find((r) => r.name === 'test')!;
    expect(test.status).toBe('failed');
    expect(test.outputTail).toContain('2 failed');
  });

  it('skips checks whose binary is missing — honestly, not as failure', async () => {
    const runner = new MockProcessRunner();
    runner.missingBinaries.add('pnpm');
    const run = await runChecks(CHECKS, runner, { cwd: '/repo' });
    expect(run.skipped).toBe(3);
    expect(run.failed).toBe(0);
    expect(run.allPassedOrSkipped).toBe(true);
    expect(run.results[0]?.detail).toMatch(/not installed/);
  });

  it('treats missing package scripts as skipped', async () => {
    const runner = new MockProcessRunner();
    runner.on(/pnpm lint/, { exitCode: 1, stderr: 'ERR_PNPM_NO_SCRIPT  Missing script: lint' });
    const run = await runChecks(CHECKS, runner, { cwd: '/repo' });
    const lint = run.results.find((r) => r.name === 'lint')!;
    expect(lint.status).toBe('skipped');
    expect(run.failed).toBe(0);
  });

  it('blocks destructive check commands without running them', async () => {
    const runner = new MockProcessRunner();
    const run = await runChecks(
      [{ name: 'evil', command: 'rm -rf / && pnpm test' }],
      runner,
      { cwd: '/repo' },
    );
    expect(run.blocked).toBe(1);
    expect(run.allPassedOrSkipped).toBe(false);
    expect(runner.commands).toHaveLength(0); // never executed
  });

  it('filters to requested checks via only', async () => {
    const runner = new MockProcessRunner();
    const run = await runChecks(CHECKS, runner, { cwd: '/repo', only: ['typecheck'] });
    expect(run.results).toHaveLength(1);
    expect(run.results[0]?.name).toBe('typecheck');
    expect(run.unknownOnlyNames).toEqual([]);
  });

  it('runs ALL configured checks when only names match nothing — never silently zero', async () => {
    // Live finding: Codex sent a command string ("npm test") instead of a
    // configured check name, which previously skipped verification silently.
    const runner = new MockProcessRunner();
    const run = await runChecks(CHECKS, runner, { cwd: '/repo', only: ['npm test'] });
    expect(run.results).toHaveLength(3); // fell back to all configured checks
    expect(run.unknownOnlyNames).toEqual(['npm test']);
  });

  it('reports unknown names even when some only names matched', async () => {
    const runner = new MockProcessRunner();
    const run = await runChecks(CHECKS, runner, { cwd: '/repo', only: ['typecheck', 'bogus'] });
    expect(run.results).toHaveLength(1);
    expect(run.unknownOnlyNames).toEqual(['bogus']);
  });

  it('marks timeouts in detail', async () => {
    const runner = new MockProcessRunner();
    runner.on(/pnpm test/, { exitCode: 1, timedOut: true });
    const run = await runChecks(CHECKS, runner, { cwd: '/repo' });
    expect(run.results.find((r) => r.name === 'test')?.detail).toBe('timed out');
  });
});
