import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { ConfigSchema, writeDefaultConfig, type KairoConfig } from '../../src/core/config.js';
import { TaskStore } from '../../src/core/task-store.js';
import { readEventLog } from '../../src/core/events.js';
import { noteCommand } from '../../src/commands/note.js';
import { inspectCommand } from '../../src/commands/inspect.js';
import { readText, writeJson, writeText } from '../../src/utils/fs.js';
import {
  makeTempDir,
  cleanupDir,
  MockHeadAdapter,
  MockDevLeadAdapter,
  MockProcessRunner,
} from '../helpers/mocks.js';

describe('stop and note (supervision control)', () => {
  let repoRoot: string;
  let config: KairoConfig;
  let head: MockHeadAdapter;
  let developmentLead: MockDevLeadAdapter;
  let runner: MockProcessRunner;
  let planAnswers: (string | null)[];
  let userAnswers: (string | null)[];

  function makeOrchestrator(): Orchestrator {
    return new Orchestrator({
      config,
      repoRoot,
      head,
      developmentLead,
      runner,
      askUser: async () => userAnswers.shift() ?? null,
      approvePlan: async () => planAnswers.shift() ?? null,
    });
  }

  function freshAdapters(): void {
    head = new MockHeadAdapter();
    developmentLead = new MockDevLeadAdapter();
    runner = new MockProcessRunner();
    planAnswers = [];
    userAnswers = [];
  }

  function store(): TaskStore {
    return new TaskStore(join(repoRoot, '.kairo'));
  }

  async function pauseAtPlanApproval(): Promise<string> {
    head.enqueueDirective(
      { action: 'delegate_to_development_lead', taskClass: 'single_phase_claude', phase: 1, instructions: 'Build the modal.' },
      '## Plan\nOne phase.',
    );
    const outcome = await makeOrchestrator().run('Build a modal');
    expect(outcome.finalState).toBe('awaiting_plan_approval');
    return outcome.taskId;
  }

  async function pauseAtUserDecision(): Promise<string> {
    head.enqueueDirective(
      { action: 'ask_user', question: 'Modal or sidebar?', reason: 'product decision' },
      'Plan.',
    );
    const outcome = await makeOrchestrator().run('Build shortcut UI');
    expect(outcome.finalState).toBe('awaiting_user_decision');
    return outcome.taskId;
  }

  beforeEach(async () => {
    repoRoot = await makeTempDir();
    await writeText(join(repoRoot, 'src', 'index.ts'), 'export {};\n');
    config = ConfigSchema.parse({ version: 1, checks: [{ name: 'test', command: 'pnpm test' }] });
    freshAdapters();
  });

  afterEach(async () => {
    await cleanupDir(repoRoot);
  });

  it('stops a paused plan-approval task: pending cleared, terminal, logged, reported, unresumable', async () => {
    const taskId = await pauseAtPlanApproval();

    freshAdapters();
    const outcome = await makeOrchestrator().stop(taskId, 'Operator decided not to proceed after reviewing the plan.');

    expect(outcome.outcome).toBe('stopped_by_user');
    expect(outcome.finalState).toBe('blocked');
    const task = await store().getTask(taskId);
    expect(task.pending).toBeNull();
    expect(task.state).toBe('blocked');
    expect(task.outcome).toBe('stopped_by_user');

    const { events } = await readEventLog(join(store().taskDir(taskId), 'agency-log.ndjson'));
    expect(events.some((e) => e.actor === 'user' && e.action === 'stop_requested' && e.status === 'completed')).toBe(true);
    expect(events.some((e) => e.action === 'stopped')).toBe(true);

    const report = await readText(outcome.reportPath!);
    expect(report).toContain('Stopped by user: Operator decided not to proceed');
    expect(report).toContain('Implementation phases run: 0');
    // No phases, clean tree -> nothing to commit, not "not safe".
    expect(report).toContain('**no commit needed**');

    // Terminal: cannot resume.
    freshAdapters();
    await expect(makeOrchestrator().resume(taskId)).rejects.toThrow(/terminal tasks cannot be resumed/);
    expect(head.invocations).toHaveLength(0);
  });

  it('stops a paused user-decision task: question preserved, report says stopped by user', async () => {
    const taskId = await pauseAtUserDecision();

    freshAdapters();
    const outcome = await makeOrchestrator().stop(taskId, 'Question needs a stakeholder meeting first.');

    expect(outcome.outcome).toBe('stopped_by_user');
    const task = await store().getTask(taskId);
    expect(task.pending).toBeNull();
    // The unanswered question is preserved in the artifacts.
    const decisions = await readText(join(store().taskDir(taskId), 'user-decisions.md'));
    expect(decisions).toContain('Modal or sidebar?');
    const report = await readText(outcome.reportPath!);
    expect(report).toContain('Stopped by user: Question needs a stakeholder meeting');
  });

  it('stop with implementation work present: report not safe to commit, phase facts stated', async () => {
    // Pause AFTER a phase via a review ask_user, then stop.
    head.enqueueDirective(
      { action: 'delegate_to_development_lead', phase: 1, instructions: 'Build it.', checksToRun: ['test'] },
      'Plan.',
    );
    developmentLead.enqueueReport(1);
    head.enqueueDirective({ action: 'ask_user', question: 'Ship as-is?', reason: 'tradeoff' }, 'Phase done.');
    planAnswers = ['y'];
    userAnswers = [null];
    runner.on(/status --porcelain/, [{ stdout: '' }, { stdout: ' M src/modal.tsx' }]);
    const paused = await makeOrchestrator().run('Build a modal');
    expect(paused.finalState).toBe('awaiting_user_decision');

    freshAdapters();
    runner.on(/status --porcelain/, { stdout: ' M src/modal.tsx' }); // task changes still in tree
    const outcome = await makeOrchestrator().stop(paused.taskId, 'Pausing the project.');

    const report = await readText(outcome.reportPath!);
    expect(report).toContain('Implementation phases run: 1');
    expect(report).toContain('Working tree has task changes: yes');
    expect(report).toContain('Checks ran after the latest implementation: yes');
    expect(report).toContain('**not safe to commit**');
    expect(report).toContain('stopped by the user before completion');
  });

  it('refuses to stop terminal tasks honestly', async () => {
    head.enqueueDirective({ action: 'stop_blocked', reason: 'nope' });
    const outcome = await makeOrchestrator().run('Blocked task');
    expect(outcome.finalState).toBe('blocked');

    freshAdapters();
    await expect(makeOrchestrator().stop(outcome.taskId, 'too late')).rejects.toThrow(/terminal tasks cannot be stopped/);
  });

  it('resolves partial task ids for stop', async () => {
    const taskId = await pauseAtPlanApproval();
    freshAdapters();
    const fragment = taskId.slice(-10); // unique suffix fragment
    const outcome = await makeOrchestrator().stop(fragment, 'partial id works');
    expect(outcome.taskId).toBe(taskId);
    expect(outcome.outcome).toBe('stopped_by_user');
  });

  it('cooperative stop at a safe boundary: requested before resume continues, loop exits before any model call', async () => {
    const taskId = await pauseAtPlanApproval();

    // Simulate a stop that raced the pause (flag written while task waited).
    await writeJson(join(store().taskDir(taskId), 'stop-requested.json'), {
      reason: 'changed my mind mid-flight',
      requestedAt: new Date().toISOString(),
    });

    freshAdapters();
    planAnswers = ['y'];
    const outcome = await makeOrchestrator().resume(taskId);

    expect(outcome.outcome).toBe('stopped_by_user');
    expect(head.invocations).toHaveLength(0); // stopped before any model call
    expect(developmentLead.invocations).toHaveLength(0);
    const report = await readText(outcome.reportPath!);
    expect(report).toContain('changed my mind mid-flight');
  });

  it('cooperative stop arriving DURING implementation: phase preserved, checks/review skipped honestly', async () => {
    head.enqueueDirective(
      { action: 'delegate_to_development_lead', phase: 1, instructions: 'Build it.', checksToRun: ['test'] },
      'Plan.',
    );
    planAnswers = ['y'];
    runner.on(/status --porcelain/, [{ stdout: '' }, { stdout: ' M src/modal.tsx' }]);
    // Claude's side effect simulates `kairo stop` firing while it works.
    const taskDirHolder: { dir?: string } = {};
    developmentLead.enqueue(
      `Working...\n\n# Phase 1 Report\n## Changed Files\n- src/modal.tsx\n## Commands Run\n- (none)\n## Risks\nnone\n## Phase Complete\nyes — done`,
      {
        sideEffect: async () => {
          const tasks = await store().listTasks();
          taskDirHolder.dir = store().taskDir(tasks[0]!.id);
          await writeJson(join(taskDirHolder.dir, 'stop-requested.json'), {
            reason: 'operator pulled the plug mid-implementation',
            requestedAt: new Date().toISOString(),
          });
        },
      },
    );

    const outcome = await makeOrchestrator().run('Build a modal');

    expect(outcome.outcome).toBe('stopped_by_user');
    // Review never happened; checks were skipped with a visible event.
    expect(head.invocations.map((i) => i.purpose)).toEqual(['triage']);
    const { events } = await readEventLog(join(taskDirHolder.dir!, 'agency-log.ndjson'));
    expect(events.some((e) => e.action === 'run_checks' && e.status === 'skipped' && e.message.includes('stop requested'))).toBe(true);
    const report = await readText(outcome.reportPath!);
    expect(report).toContain('Implementation phases run: 1');
    expect(report).toContain('Checks ran after the latest implementation: no');
    expect(report).toContain('**not safe to commit**');
  });

  it('notes persist, surface in inspect, and never consume the pending checkpoint', async () => {
    await writeDefaultConfig(repoRoot); // commands load config from disk
    const taskId = await pauseAtUserDecision();

    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
    try {
      await noteCommand(repoRoot, taskId, 'Keep the change copy-only. No new routes.');
      await inspectCommand(repoRoot, taskId);
    } finally {
      spy.mockRestore();
    }
    const output = lines.join('\n');
    expect(output).toContain('note recorded');
    expect(output).toContain('notes do not answer it'); // pending guidance
    expect(output).toContain('manager notes (last 1 of 1)');
    expect(output).toContain('Keep the change copy-only');

    const task = await store().getTask(taskId);
    expect(task.pending?.kind).toBe('user_decision'); // checkpoint untouched
    expect(await readText(join(store().taskDir(taskId), 'manager-notes.md'))).toContain('No new routes.');
    const { events } = await readEventLog(join(store().taskDir(taskId), 'agency-log.ndjson'));
    expect(events.some((e) => e.actor === 'user' && e.action === 'note')).toBe(true);
  });

  it('manager notes reach review, implementation, and after-decision prompts (bounded)', async () => {
    const taskId = await pauseAtPlanApproval();
    await writeText(
      join(store().taskDir(taskId), 'manager-notes.md'),
      `## 2026-06-07T12:00:00.000Z\n\nKeep the change copy-only. Do not add new routes or payment semantics.\n\n`,
    );

    freshAdapters();
    planAnswers = ['y'];
    developmentLead.enqueueReport(1);
    head.enqueueDirective({ action: 'declare_complete', reason: 'done' });
    runner.on(/status --porcelain/, [{ stdout: '' }, { stdout: ' M src/x.ts' }]);

    const outcome = await makeOrchestrator().resume(taskId, 'y');

    expect(outcome.outcome).toBe('completed');
    expect(developmentLead.invocations[0]?.prompt).toContain('## Recent Manager Notes');
    expect(developmentLead.invocations[0]?.prompt).toContain('copy-only');
    const reviewPrompt = head.invocations.find((i) => i.purpose === 'review-phase-1')?.prompt ?? '';
    expect(reviewPrompt).toContain('## Recent Manager Notes');
    expect(reviewPrompt).toContain('Do not add new routes or payment semantics.');
  });
});
