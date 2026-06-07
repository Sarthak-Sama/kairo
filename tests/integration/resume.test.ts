import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { ConfigSchema, writeDefaultConfig, type KairoConfig } from '../../src/core/config.js';
import { TaskStore } from '../../src/core/task-store.js';
import { inspectCommand } from '../../src/commands/inspect.js';
import { readText, writeText } from '../../src/utils/fs.js';
import {
  makeTempDir,
  cleanupDir,
  MockHeadAdapter,
  MockDevLeadAdapter,
  MockProcessRunner,
} from '../helpers/mocks.js';

describe('resume / ask (mocked adapters)', () => {
  let repoRoot: string;
  let config: KairoConfig;
  let head: MockHeadAdapter;
  let developmentLead: MockDevLeadAdapter;
  let runner: MockProcessRunner;
  let userAnswers: (string | null)[];
  let planAnswers: (string | null)[];

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

  /** Fresh adapters/runner, as a separate `kairo resume`/`ask` process would have. */
  function freshProcess(): void {
    head = new MockHeadAdapter();
    developmentLead = new MockDevLeadAdapter();
    runner = new MockProcessRunner();
    userAnswers = [];
    planAnswers = [];
  }

  function store(): TaskStore {
    return new TaskStore(join(repoRoot, '.kairo'));
  }

  /** Run a task that pauses at plan approval; returns the task id. */
  async function pauseAtPlanApproval(): Promise<string> {
    head.enqueueDirective(
      { action: 'delegate_to_development_lead', taskClass: 'single_phase_claude', phase: 1, instructions: 'Build the modal.' },
      '## Plan\nOne phase.',
    );
    planAnswers = [null]; // non-interactive -> pause
    const outcome = await makeOrchestrator().run('Build a modal');
    expect(outcome.finalState).toBe('awaiting_plan_approval');
    return outcome.taskId;
  }

  /** Run a task that pauses at a user decision; returns the task id. */
  async function pauseAtUserDecision(): Promise<string> {
    head.enqueueDirective(
      { action: 'ask_user', question: 'Modal or sidebar?', reason: 'product decision' },
      '## Plan\nPending decision.',
    );
    userAnswers = [null];
    const outcome = await makeOrchestrator().run('Build shortcut UI');
    expect(outcome.finalState).toBe('awaiting_user_decision');
    return outcome.taskId;
  }

  beforeEach(async () => {
    repoRoot = await makeTempDir();
    await writeText(join(repoRoot, 'src', 'index.ts'), 'export const x = 1;\n');
    config = ConfigSchema.parse({ version: 1, checks: [{ name: 'test', command: 'pnpm test' }] });
    freshProcess();
  });

  afterEach(async () => {
    await cleanupDir(repoRoot);
  });

  it('plan approval pause persists pending.kind = "plan_approval" with the directive', async () => {
    const taskId = await pauseAtPlanApproval();
    const task = await store().getTask(taskId);
    expect(task.pending?.kind).toBe('plan_approval');
    if (task.pending?.kind !== 'plan_approval') throw new Error('unreachable');
    expect(task.pending.directive.action).toBe('delegate_to_development_lead');
    expect(task.pending.directive.instructions).toBe('Build the modal.');
    expect(task.pending.planPath).toContain('master-plan.md');
    expect(task.pending.createdAt).toBeTruthy();
  });

  it('user decision pause persists pending.kind = "user_decision" with the question', async () => {
    const taskId = await pauseAtUserDecision();
    const task = await store().getTask(taskId);
    expect(task.pending?.kind).toBe('user_decision');
    if (task.pending?.kind !== 'user_decision') throw new Error('unreachable');
    expect(task.pending.question).toBe('Modal or sidebar?');
    expect(task.pending.directive.action).toBe('ask_user');
  });

  it('resume from plan approval with interactive approval continues to Claude and clears pending', async () => {
    const taskId = await pauseAtPlanApproval();

    freshProcess();
    planAnswers = ['y']; // interactive resume prompt answers approve
    developmentLead.enqueueReport(1);
    head.enqueueDirective({ action: 'declare_complete', reason: 'done' });
    runner.on(/status --porcelain/, [{ stdout: '' }, { stdout: ' M src/modal.tsx' }]);

    const outcome = await makeOrchestrator().resume(taskId);

    expect(outcome.outcome).toBe('completed');
    expect(developmentLead.invocations).toHaveLength(1);
    expect(developmentLead.invocations[0]?.prompt).toContain('Build the modal.');
    const task = await store().getTask(taskId);
    expect(task.pending).toBeNull();
    expect(task.state).toBe('reported');
    expect(task.stateHistory.map((h) => h.state)).toContain('planning_approved');
  });

  it('ask with feedback from plan approval revises the plan and re-pauses on the revised directive', async () => {
    const taskId = await pauseAtPlanApproval();

    freshProcess();
    // `kairo ask` semantics: input handles the pending interaction; any
    // follow-up interaction pauses again (approvePlan stays null).
    head.enqueueDirective(
      { action: 'delegate_to_development_lead', taskClass: 'single_phase_claude', phase: 1, instructions: 'Build a SMALLER modal.' },
      '## Revised Plan\nSmaller scope.',
    );

    const outcome = await makeOrchestrator().resume(taskId, 'Make it smaller');

    expect(outcome.finalState).toBe('awaiting_plan_approval');
    expect(head.invocations.map((i) => i.purpose)).toContain('plan-feedback');
    const task = await store().getTask(taskId);
    expect(task.pending?.kind).toBe('plan_approval');
    expect(task.pending?.directive.instructions).toBe('Build a SMALLER modal.'); // revised directive persisted
    const taskDir = store().taskDir(taskId);
    expect(await readText(join(taskDir, 'master-plan.md'))).toContain('Revised Plan');
    expect(await readText(join(taskDir, 'user-decisions.md'))).toContain('Make it smaller');

    // Second ask approves the revised plan and runs to completion.
    freshProcess();
    developmentLead.enqueueReport(1);
    head.enqueueDirective({ action: 'declare_complete', reason: 'done' });
    const second = await makeOrchestrator().resume(taskId, 'y');
    expect(second.outcome).toBe('completed');
    expect(developmentLead.invocations[0]?.prompt).toContain('Build a SMALLER modal.');
    expect((await store().getTask(taskId)).pending).toBeNull();
  });

  it('ask with an answer from user decision continues through Codex and then implementation', async () => {
    const taskId = await pauseAtUserDecision();

    freshProcess();
    head.enqueueDirective(
      { action: 'delegate_to_development_lead', phase: 1, instructions: 'Build a modal as chosen.' },
      'Proceeding with modal.',
    );
    developmentLead.enqueueReport(1);
    head.enqueueDirective({ action: 'declare_complete', reason: 'done' });
    planAnswers = ['y']; // the post-decision delegation still passes the gate

    const outcome = await makeOrchestrator().resume(taskId, 'Use a modal');

    expect(outcome.outcome).toBe('completed');
    expect(head.invocations.map((i) => i.purpose)).toContain('after-user-decision');
    expect(developmentLead.invocations).toHaveLength(1);
    const task = await store().getTask(taskId);
    expect(task.pending).toBeNull();
    const decisions = await readText(join(store().taskDir(taskId), 'user-decisions.md'));
    expect(decisions).toContain('Modal or sidebar?');
    expect(decisions).toContain('Use a modal');
  });

  it('empty answer on interactive resume leaves the task paused with pending intact', async () => {
    const taskId = await pauseAtPlanApproval();

    freshProcess();
    planAnswers = [null];
    const outcome = await makeOrchestrator().resume(taskId);

    expect(outcome.outcome).toBe('still_paused');
    const task = await store().getTask(taskId);
    expect(task.state).toBe('awaiting_plan_approval');
    expect(task.pending?.kind).toBe('plan_approval');
  });

  it('refuses to resume terminal tasks', async () => {
    head.enqueueDirective({ action: 'stop_blocked', reason: 'nope' });
    const outcome = await makeOrchestrator().run('Blocked task');
    expect(outcome.finalState).toBe('blocked');

    freshProcess();
    await expect(makeOrchestrator().resume(outcome.taskId)).rejects.toThrow(/terminal tasks cannot be resumed/);
  });

  it('refuses to resume non-paused tasks', async () => {
    const task = await store().createTask({ id: 'manual-task', title: 'x', repoRoot });
    await store().transition(task.id, 'implementing');

    await expect(makeOrchestrator().resume('manual-task')).rejects.toThrow(/not paused \(state: implementing\)/);
  });

  it('refuses paused tasks without pending metadata (pre-resumability)', async () => {
    const task = await store().createTask({ id: 'legacy-task', title: 'x', repoRoot });
    await store().transition(task.id, 'awaiting_plan_approval');

    await expect(makeOrchestrator().resume('legacy-task')).rejects.toThrow(/no pending metadata/);
  });

  it('blocks resume before any implementation if the working tree became dirty', async () => {
    const taskId = await pauseAtPlanApproval();

    freshProcess();
    planAnswers = ['y'];
    runner.on(/status --porcelain/, { stdout: ' M src/unrelated-user-work.ts' });

    await expect(makeOrchestrator().resume(taskId)).rejects.toThrow(/commit or stash them, then resume again/);
    expect(head.invocations).toHaveLength(0); // refused before any model call
    const task = await store().getTask(taskId);
    expect(task.state).toBe('awaiting_plan_approval'); // unchanged — retry after cleaning
    expect(task.pending?.kind).toBe('plan_approval');
  });

  it('allows resume after prior implementation with a dirty tree, recording a medium risk', async () => {
    // Pause AFTER phase 1: delegate -> implement -> review asks the user.
    head.enqueueDirective(
      { action: 'delegate_to_development_lead', taskClass: 'single_phase_claude', phase: 1, instructions: 'Build it.' },
      'Plan.',
    );
    developmentLead.enqueueReport(1);
    head.enqueueDirective(
      { action: 'ask_user', question: 'Ship as-is or harden first?', reason: 'tradeoff' },
      'Phase 1 done; tradeoff question.',
    );
    planAnswers = ['y'];
    userAnswers = [null]; // pause at the decision
    runner.on(/status --porcelain/, [{ stdout: '' }, { stdout: ' M src/modal.tsx' }]);
    runner.on(/^git diff HEAD/, { stdout: 'diff --git a/src/modal.tsx b/src/modal.tsx\n+modal' });
    const paused = await makeOrchestrator().run('Build a modal');
    expect(paused.finalState).toBe('awaiting_user_decision');
    const taskId = paused.taskId;

    freshProcess();
    runner.on(/status --porcelain/, { stdout: ' M src/modal.tsx' }); // Kairo's own phase-1 changes
    head.enqueueDirective({ action: 'declare_complete', reason: 'ship as-is' });

    const outcome = await makeOrchestrator().resume(taskId, 'Ship as-is');

    expect(outcome.outcome).toBe('completed');
    const report = await readText(outcome.reportPath!);
    expect(report).toContain('medium: resumed with existing working-tree changes from prior task phases');
    expect(report).toContain('**needs manual review**');
    // Reconstructed phase context made it into the report.
    expect(report).toContain('src/modal.tsx'); // changed file recovered from phase-1 diff.patch
  });

  it('kairo inspect shows pending metadata', async () => {
    await writeDefaultConfig(repoRoot); // inspectCommand loads config from disk
    const taskId = await pauseAtUserDecision();
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
    try {
      await inspectCommand(repoRoot, taskId);
    } finally {
      spy.mockRestore();
    }
    const output = lines.join('\n');
    expect(output).toContain('pending:');
    expect(output).toContain('user_decision');
    expect(output).toContain('Modal or sidebar?');
    expect(output).toContain(`kairo resume ${taskId}`);
  });
});
