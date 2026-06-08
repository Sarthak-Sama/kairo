import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { chmod } from 'node:fs/promises';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { ConfigSchema, type KairoConfig } from '../../src/core/config.js';
import { TaskStore } from '../../src/core/task-store.js';
import { readEventLog } from '../../src/core/events.js';
import { FileCancellationSignal, type CancellationSignal } from '../../src/core/cancellation.js';
import { ExecaProcessRunner } from '../../src/adapters/process-runner.js';
import { ClaudeCliAdapter } from '../../src/adapters/claude.js';
import { ClaudePtyAdapter, type PtyModule, type PtyProcess } from '../../src/adapters/claude-pty.js';
import { readJson, readText, writeJson, writeText } from '../../src/utils/fs.js';
import {
  makeTempDir,
  cleanupDir,
  MockHeadAdapter,
  MockDevLeadAdapter,
  MockProcessRunner,
} from '../helpers/mocks.js';

/** A signal that flips to cancelled after `afterMs`. */
function timedSignal(afterMs: number, reason = 'test cancellation'): CancellationSignal {
  const deadline = Date.now() + afterMs;
  return {
    isCancellationRequested: async () => Date.now() >= deadline,
    reason: async () => reason,
  };
}

describe('ProcessRunner cancellation (owned children only)', () => {
  it('terminates the owned child, preserves partial stdout, never searches globally', async () => {
    const runner = new ExecaProcessRunner();
    const started = Date.now();
    const result = await runner.runShell('echo partial-before-sleep && sleep 30', {
      cwd: '/tmp',
      skipSafetyCheck: true,
      cancellation: timedSignal(150),
      cancellationPollMs: 50,
    });
    expect(result.cancelled).toBe(true);
    expect(result.stdout).toContain('partial-before-sleep'); // partial output preserved
    expect(Date.now() - started).toBeLessThan(5_000); // did not wait for the sleep
  });

  it('normal completion is unaffected by an unfired signal', async () => {
    const runner = new ExecaProcessRunner();
    const result = await runner.runShell('echo done', {
      cwd: '/tmp',
      skipSafetyCheck: true,
      cancellation: timedSignal(60_000),
      cancellationPollMs: 50,
    });
    expect(result.cancelled).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('done');
  });
});

describe('Claude print adapter cancellation', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await cleanupDir(dir);
  });

  it('cancels the owned subprocess and preserves the partial transcript', async () => {
    // A fake claude binary that prints partial output then hangs.
    const fakeClaude = join(dir, 'fake-claude');
    await writeText(fakeClaude, '#!/bin/sh\necho "partial claude output"\nsleep 30\n');
    await chmod(fakeClaude, 0o755);
    const config: KairoConfig = ConfigSchema.parse({ version: 1, claude: { command: fakeClaude } });

    const adapter = new ClaudeCliAdapter(new ExecaProcessRunner(), config, dir);
    const result = await adapter.invoke({
      prompt: 'do work',
      purpose: 'test',
      // Generous deadline so the partial echo lands before cancellation even
      // under parallel test load; the sleep is long enough that completion
      // can only happen via cancellation.
      cancellation: timedSignal(600, 'operator cancelled'),
    });

    expect(result.cancelled).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.transcript).toContain('partial claude output');
    expect(result.error).toContain('cancelled by user: operator cancelled');
  });
});

describe('Claude PTY adapter cancellation', () => {
  class FakeProc implements PtyProcess {
    killed = false;
    private dataCb: ((d: string) => void) | null = null;
    onData(cb: (d: string) => void): void {
      this.dataCb = cb;
    }
    onExit(): void {}
    write(): void {}
    kill(): void {
      this.killed = true;
    }
    emit(d: string): void {
      this.dataCb?.(d);
    }
  }

  it('kills the owned PTY and preserves the transcript so far', async () => {
    const proc = new FakeProc();
    const mod: PtyModule = {
      spawn: () => {
        setTimeout(() => proc.emit('streamed partial'), 10);
        return proc; // never exits on its own
      },
    };
    const adapter = new ClaudePtyAdapter(
      new MockProcessRunner(),
      ConfigSchema.parse({ version: 1, claude: { transport: 'pty' } }),
      '/repo',
      async () => mod,
      60_000, // timeout NOT the thing firing here
      25, // fast cancellation poll for the test
    );
    const result = await adapter.invoke({
      prompt: 'x',
      purpose: 'test',
      cancellation: timedSignal(60, 'pty cancel test'),
    });
    expect(result.cancelled).toBe(true);
    expect(result.transcript).toBe('streamed partial');
    expect(result.error).toContain('pty cancel test');
    expect(proc.killed).toBe(true);
  });
});

describe('orchestrator cancellation routing (mocked adapters)', () => {
  let repoRoot: string;
  let config: KairoConfig;
  let head: MockHeadAdapter;
  let developmentLead: MockDevLeadAdapter;
  let runner: MockProcessRunner;
  let planAnswers: (string | null)[];

  function makeOrchestrator(): Orchestrator {
    return new Orchestrator({
      config,
      repoRoot,
      head,
      developmentLead,
      runner,
      askUser: async () => null,
      approvePlan: async () => planAnswers.shift() ?? null,
    });
  }

  function store(): TaskStore {
    return new TaskStore(join(repoRoot, '.kairo'));
  }

  beforeEach(async () => {
    repoRoot = await makeTempDir();
    await writeText(join(repoRoot, 'src', 'index.ts'), 'export {};\n');
    config = ConfigSchema.parse({ version: 1, checks: [{ name: 'test', command: 'pnpm test' }] });
    head = new MockHeadAdapter();
    developmentLead = new MockDevLeadAdapter();
    runner = new MockProcessRunner();
    planAnswers = [];
  });

  afterEach(async () => {
    await cleanupDir(repoRoot);
  });

  it('kairo stop writes the control.json signal for an active (non-paused) task', async () => {
    const task = await store().createTask({ id: 'active-task', title: 'x', repoRoot });
    await store().transition(task.id, 'implementing');

    const outcome = await makeOrchestrator().stop('active-task', 'cancel it now');

    expect(outcome.outcome).toBe('stop_requested'); // honest: not yet stopped
    const control = await readJson<{ stopRequested: boolean; reason: string; requestedAt: string }>(
      join(store().taskDir('active-task'), 'control.json'),
    );
    expect(control.stopRequested).toBe(true);
    expect(control.reason).toBe('cancel it now');
    expect(control.requestedAt).toBeTruthy();
    // The signal is observable by transports.
    const signal = new FileCancellationSignal([join(store().taskDir('active-task'), 'control.json')]);
    expect(await signal.isCancellationRequested()).toBe(true);
    expect(await signal.reason()).toBe('cancel it now');
  });

  it('cancellation during the head call stops honestly with no implementation', async () => {
    head.enqueueCancelled('partial triage thinking…');

    const outcome = await makeOrchestrator().run('Build something');

    expect(outcome.outcome).toBe('stopped_by_user');
    expect(outcome.finalState).toBe('blocked');
    expect(developmentLead.invocations).toHaveLength(0);
    const taskDir = store().taskDir(outcome.taskId);
    const { events } = await readEventLog(join(taskDir, 'agency-log.ndjson'));
    expect(events.some((e) => e.action === 'cancel_active_process' && e.message.includes('head triage'))).toBe(true);
    const report = await readText(outcome.reportPath!);
    expect(report).toContain('Cancellation happened during an active model call (head triage)');
  });

  it('cancellation during development implementation: partial transcript, diff captured, not safe, no review/checks', async () => {
    head.enqueueDirective(
      { action: 'delegate_to_development_lead', phase: 1, instructions: 'Build it.', checksToRun: ['test'] },
      'Plan.',
    );
    head.enqueueRaw('a review that must never be consumed');
    planAnswers = ['y'];
    // The dev lead is cancelled mid-implementation with partial output; the
    // sideEffect writes control.json exactly when `kairo stop` would (while
    // the implementation process is running), and the partial work left the
    // tree dirty.
    developmentLead.enqueue('I started building the modal but was interr', {
      cancelled: true,
      sideEffect: async () => {
        const tasks = await store().listTasks();
        await writeJson(join(store().taskDir(tasks[0]!.id), 'control.json'), {
          stopRequested: true,
          reason: 'operator cancelled mid-implementation',
          requestedAt: new Date().toISOString(),
        });
      },
    });
    runner.on(/status --porcelain/, [{ stdout: '' }, { stdout: ' M src/modal.tsx' }]);
    runner.on(/^git diff HEAD/, { stdout: 'diff --git a/src/modal.tsx b/src/modal.tsx\n+partial work' });

    const outcome = await makeOrchestrator().run('Build a modal');

    expect(outcome.outcome).toBe('stopped_by_user');
    const taskDir = store().taskDir(outcome.taskId);

    // Partial transcript preserved.
    const transcript = await readText(join(taskDir, 'phase-001', 'development-lead-transcript.log'));
    expect(transcript).toContain('I started building the modal but was interr');

    // Diff captured after cancellation.
    expect(await readText(join(taskDir, 'phase-001', 'diff.patch'))).toContain('+partial work');

    // No review, no checks after the cancellation.
    expect(head.invocations.map((i) => i.purpose)).toEqual(['triage']);
    const { events } = await readEventLog(join(taskDir, 'agency-log.ndjson'));
    expect(events.some((e) => e.action === 'review')).toBe(false);
    expect(events.some((e) => e.actor === 'checks' && e.action === 'run_checks' && e.status === 'started')).toBe(false);
    expect(events.some((e) => e.action === 'cancel_active_process' && e.message.includes('development lead'))).toBe(true);

    // Report: honest, not safe, mid-flight risk, reason recorded.
    const report = await readText(outcome.reportPath!);
    expect(report).toContain('Stopped by user: operator cancelled mid-implementation');
    expect(report).toContain('Cancellation happened during an active model call (development lead implementation)');
    expect(report).toContain('was cancelled mid-flight — changes may be partial');
    expect(report).toContain('**not safe to commit**');
    expect(report).toContain('Implementation phases run: 1');
  });

  it('the dev-lead invocation actually receives a cancellation signal', async () => {
    head.enqueueDirective(
      { action: 'delegate_to_development_lead', phase: 1, instructions: 'Build it.' },
      'Plan.',
    );
    developmentLead.enqueueReport(1);
    head.enqueueDirective({ action: 'declare_complete', reason: 'done' });
    planAnswers = ['y'];
    runner.on(/status --porcelain/, [{ stdout: '' }, { stdout: ' M src/x.ts' }]);

    await makeOrchestrator().run('Build something');

    expect(developmentLead.invocations[0]?.cancellation).toBeDefined();
    expect(head.invocations[0]?.cancellation).toBeDefined();
  });
});
