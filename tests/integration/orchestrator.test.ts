import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { Orchestrator, requiresPlanApproval } from '../../src/core/orchestrator.js';
import { ConfigSchema, type KairoConfig } from '../../src/core/config.js';
import { TaskStore } from '../../src/core/task-store.js';
import { readEventLog } from '../../src/core/events.js';
import { DirectiveSchema } from '../../src/core/directives.js';
import { fileExists, readText, writeText } from '../../src/utils/fs.js';
import {
  makeTempDir,
  cleanupDir,
  MockCodexAdapter,
  MockClaudeAdapter,
  MockProcessRunner,
} from '../helpers/mocks.js';

describe('orchestrator (mocked adapters)', () => {
  let repoRoot: string;
  let config: KairoConfig;
  let codex: MockCodexAdapter;
  let claude: MockClaudeAdapter;
  let runner: MockProcessRunner;
  let userAnswers: string[];
  let planAnswers: (string | null)[];
  let approveCalls: number;

  function makeOrchestrator(): Orchestrator {
    return new Orchestrator({
      config,
      repoRoot,
      codex,
      claude,
      runner,
      askUser: async () => userAnswers.shift() ?? null,
      approvePlan: async () => {
        approveCalls++;
        return planAnswers.shift() ?? null;
      },
    });
  }

  function store(): TaskStore {
    return new TaskStore(join(repoRoot, '.kairo'));
  }

  /** Status sequence: clean at baseline, then the given output for diff capture. */
  function statusAfterBaseline(...outputs: string[]): void {
    runner.on(/status --porcelain/, [{ stdout: '' }, ...outputs.map((stdout) => ({ stdout }))]);
  }

  beforeEach(async () => {
    repoRoot = await makeTempDir();
    await writeText(join(repoRoot, 'src', 'index.ts'), 'export const x = 1;\n');
    config = ConfigSchema.parse({
      version: 1,
      checks: [{ name: 'test', command: 'pnpm test' }],
    });
    codex = new MockCodexAdapter();
    claude = new MockClaudeAdapter();
    runner = new MockProcessRunner();
    userAnswers = [];
    planAnswers = [];
    approveCalls = 0;
  });

  afterEach(async () => {
    await cleanupDir(repoRoot);
  });

  describe('git preflight', () => {
    it('blocks in a non-git repo before any model call', async () => {
      runner.on(/is-inside-work-tree/, { exitCode: 128, stdout: '' });

      const outcome = await makeOrchestrator().run('Build something');

      expect(outcome.outcome).toBe('blocked');
      expect(codex.invocations).toHaveLength(0);
      expect(claude.invocations).toHaveLength(0);
      const report = await readText(outcome.reportPath!);
      expect(report).toContain('git');
      expect(report).toContain('diff accountability');
      expect(report).toContain('**not safe to commit**');
      const task = await store().getTask(outcome.taskId);
      expect(task.state).toBe('blocked');
    });

    it('blocks on a dirty working tree before any model call', async () => {
      runner.on(/status --porcelain/, { stdout: ' M src/existing-work.ts' });

      const outcome = await makeOrchestrator().run('Build something');

      expect(outcome.outcome).toBe('blocked');
      expect(codex.invocations).toHaveLength(0);
      expect(claude.invocations).toHaveLength(0);
      const report = await readText(outcome.reportPath!);
      expect(report).toMatch(/commit or stash/i);
      expect(report).toContain('**not safe to commit**');
      // No stash/clean/commit was attempted
      expect(runner.commands.some((c) => /stash|clean|commit/.test(c))).toBe(false);
    });
  });

  describe('plan approval gate', () => {
    it('non-trivial delegation pauses as awaiting_plan_approval in non-interactive mode, before Claude', async () => {
      codex.enqueueDirective(
        { action: 'delegate_to_claude', taskClass: 'single_phase_claude', phase: 1, instructions: 'Build it.' },
        '## Plan\nOne phase.',
      );
      planAnswers = [null]; // non-interactive

      const outcome = await makeOrchestrator().run('Build a modal');

      expect(outcome.finalState).toBe('awaiting_plan_approval');
      expect(claude.invocations).toHaveLength(0);
      expect(codex.invocations).toHaveLength(1); // triage only
      const task = await store().getTask(outcome.taskId);
      expect(task.state).toBe('awaiting_plan_approval');
      expect(await fileExists(outcome.reportPath!)).toBe(true);
      const decisions = await readText(join(store().taskDir(outcome.taskId), 'user-decisions.md'));
      expect(decisions).toContain('Plan approval requested');
    });

    it('approved plan continues to Claude', async () => {
      codex.enqueueDirective(
        { action: 'delegate_to_claude', taskClass: 'single_phase_claude', phase: 1, instructions: 'Build it.' },
        'Plan.',
      );
      claude.enqueueReport(1);
      codex.enqueueDirective({ action: 'declare_complete', reason: 'done' });
      planAnswers = ['y'];
      statusAfterBaseline(' M src/modal.tsx');

      const outcome = await makeOrchestrator().run('Build a modal');

      expect(outcome.outcome).toBe('completed');
      expect(approveCalls).toBe(1);
      expect(claude.invocations).toHaveLength(1);
      const task = await store().getTask(outcome.taskId);
      expect(task.stateHistory.map((h) => h.state)).toContain('awaiting_plan_approval');
      expect(task.stateHistory.map((h) => h.state)).toContain('planning_approved');
    });

    it('feedback re-invokes Codex and the revised directive is used (then approved)', async () => {
      codex.enqueueDirective(
        { action: 'delegate_to_claude', taskClass: 'single_phase_claude', phase: 1, instructions: 'Build a big thing.' },
        'Big plan.',
      );
      // Codex's revision after feedback:
      codex.enqueueDirective(
        { action: 'delegate_to_claude', taskClass: 'single_phase_claude', phase: 1, instructions: 'Build a smaller thing.' },
        'Smaller plan per feedback.',
      );
      claude.enqueueReport(1);
      codex.enqueueDirective({ action: 'declare_complete', reason: 'done' });
      planAnswers = ['Make it smaller in scope.', 'y'];
      statusAfterBaseline(' M src/modal.tsx');

      const outcome = await makeOrchestrator().run('Build a modal');

      expect(outcome.outcome).toBe('completed');
      expect(approveCalls).toBe(2);
      expect(codex.invocations.map((i) => i.purpose)).toContain('plan-feedback');
      expect(claude.invocations[0]?.prompt).toContain('Build a smaller thing.');
      const taskDir = store().taskDir(outcome.taskId);
      const decisions = await readText(join(taskDir, 'user-decisions.md'));
      expect(decisions).toContain('Make it smaller in scope.');
      // Revised plan prose replaced the master plan
      expect(await readText(join(taskDir, 'master-plan.md'))).toContain('Smaller plan per feedback.');
    });

    it('quick low-risk self-edit bypasses approval', async () => {
      codex.enqueueDirective(
        { action: 'self_edit', taskClass: 'quick_self_edit', risk: 'low', reason: 'tiny fix', instructions: 'Fix the typo in README.md.' },
        'Plan: fix typo.',
      );
      codex.enqueueRaw('Fixed the typo in README.md. One word changed.');
      codex.enqueueDirective({ action: 'declare_complete', reason: 'done' });
      statusAfterBaseline(' M README.md');

      const outcome = await makeOrchestrator().run('Fix typo');

      expect(outcome.outcome).toBe('completed');
      expect(approveCalls).toBe(0); // gate bypassed
    });

    it('high-risk self-edit still requires approval', async () => {
      codex.enqueueDirective(
        { action: 'self_edit', taskClass: 'quick_self_edit', risk: 'high', reason: 'touches auth', instructions: 'Edit auth config.' },
        'Plan.',
      );
      planAnswers = [null];

      const outcome = await makeOrchestrator().run('Tweak auth');

      expect(outcome.finalState).toBe('awaiting_plan_approval');
      expect(approveCalls).toBe(1);
      expect(codex.invocations).toHaveLength(1); // no self-edit session ran
    });
  });

  describe('codex self-edit split', () => {
    it('self-edit runs a separate write-enabled Codex invocation; triage is read-only', async () => {
      codex.enqueueDirective(
        { action: 'self_edit', taskClass: 'quick_self_edit', risk: 'low', reason: 'tiny', instructions: 'Fix the typo.' },
        'Plan.',
      );
      codex.enqueueRaw('Edited README.md: fixed typo.');
      codex.enqueueDirective({ action: 'declare_complete', reason: 'done' });
      statusAfterBaseline(' M README.md');

      const outcome = await makeOrchestrator().run('Fix typo');

      expect(outcome.outcome).toBe('completed');
      const purposes = codex.invocations.map((i) => i.purpose);
      expect(purposes).toEqual(['triage', 'self-edit-phase-1', 'review-phase-1']);
      expect(codex.invocations[0]?.sandbox).toBe('read-only');
      expect(codex.invocations[1]?.sandbox).toBe('workspace-write');
      expect(codex.invocations[2]?.sandbox).toBe('read-only');

      const phaseDir = join(store().taskDir(outcome.taskId), 'phase-001');
      expect(await fileExists(join(phaseDir, 'codex-self-edit-prompt.md'))).toBe(true);
      const transcript = await readText(join(phaseDir, 'codex-self-edit-transcript.md'));
      expect(transcript).toContain('fixed typo');
    });

    it('self-edit producing no diff fails the run instead of continuing', async () => {
      codex.enqueueDirective(
        { action: 'self_edit', taskClass: 'quick_self_edit', risk: 'low', reason: 'tiny', instructions: 'Fix it.' },
        'Plan.',
      );
      codex.enqueueRaw('I made the edit (but actually changed nothing).');
      // status stays clean: baseline clean, post-self-edit clean

      const outcome = await makeOrchestrator().run('Fix typo');

      expect(outcome.outcome).toBe('failed');
      const report = await readText(outcome.reportPath!);
      expect(report).toContain('no working-tree changes');
      const { events } = await readEventLog(join(store().taskDir(outcome.taskId), 'agency-log.ndjson'));
      expect(events.some((e) => e.action === 'self_edit_verification' && e.status === 'failed')).toBe(true);
    });

    it('self-edit invocation failure fails the run visibly', async () => {
      codex.enqueueDirective(
        { action: 'self_edit', taskClass: 'quick_self_edit', risk: 'low', reason: 'tiny', instructions: 'Fix it.' },
        'Plan.',
      );
      // queue empty -> self-edit invoke fails

      const outcome = await makeOrchestrator().run('Fix typo');

      expect(outcome.outcome).toBe('failed');
      expect(await fileExists(outcome.reportPath!)).toBe(true);
    });
  });

  it('claude delegation path: full implement -> diff -> checks -> review -> complete', async () => {
    codex.enqueueDirective(
      {
        action: 'delegate_to_claude',
        taskClass: 'single_phase_claude',
        phase: 1,
        instructions: 'Build the modal component.',
        successCriteria: ['Modal opens via shortcut'],
        checksToRun: ['test'],
      },
      '## Master Plan\nOne phase: build modal.',
    );
    claude.enqueueReport(1, { files: ['src/modal.tsx'] });
    codex.enqueueDirective({ action: 'declare_complete', reason: 'matches plan' }, 'Reviewed. Clean diff.');
    planAnswers = ['y'];
    statusAfterBaseline(' M src/modal.tsx');
    runner.on(/^git diff HEAD/, { stdout: 'diff --git a/src/modal.tsx b/src/modal.tsx\n+modal' });

    const outcome = await makeOrchestrator().run('Build a keyboard shortcut helper modal');

    expect(outcome.outcome).toBe('completed');
    expect(claude.invocations).toHaveLength(1);
    expect(claude.invocations[0]?.prompt).toContain('Build the modal component.');
    expect(claude.invocations[0]?.prompt).toContain('Do NOT commit');

    const taskDir = store().taskDir(outcome.taskId);
    const phaseDir = join(taskDir, 'phase-001');
    expect(await fileExists(join(phaseDir, 'claude-prompt.md'))).toBe(true);
    expect(await fileExists(join(phaseDir, 'claude-transcript.log'))).toBe(true);
    expect(await fileExists(join(phaseDir, 'claude-report.md'))).toBe(true);
    expect(await fileExists(join(phaseDir, 'diff.patch'))).toBe(true);
    expect(await fileExists(join(phaseDir, 'codex-review.md'))).toBe(true);
    expect(await fileExists(join(phaseDir, 'codex-decision.json'))).toBe(true);
    expect(await readText(join(phaseDir, 'diff.patch'))).toContain('src/modal.tsx');

    const { events } = await readEventLog(join(taskDir, 'agency-log.ndjson'));
    const actions = events.map((e) => `${e.actor}:${e.action}:${e.status}`);
    expect(actions).toContain('claude:implement:completed');
    expect(actions).toContain('checks:run_checks:completed');
    expect(actions).toContain('codex:review:completed');

    // Transcript streamed via onChunk lands exactly once — no duplication
    // between chunk streaming and the buffered-fallback final write.
    const transcript = await readText(join(phaseDir, 'claude-transcript.log'));
    expect(transcript.match(/# Phase 1 Report/g)).toHaveLength(1);
    expect(transcript).not.toContain('(empty transcript)');

    // Clean baseline is reflected in the report
    const report = await readText(outcome.reportPath!);
    expect(report).toContain('clean working tree');
    expect(report).toContain('**safe to commit**');
  });

  it('failed check path: checks fail, codex requests revision, revision passes', async () => {
    codex.enqueueDirective(
      { action: 'delegate_to_claude', taskClass: 'single_phase_claude', phase: 1, instructions: 'Build it.', checksToRun: ['test'] },
      'Plan.',
    );
    claude.enqueueReport(1);
    codex.enqueueDirective(
      { action: 'request_claude_revision', phase: 1, instructions: 'Fix the failing test.', checksToRun: ['test'] },
      'Test failed — revise.',
    );
    claude.enqueueReport(1, { files: ['src/modal.tsx', 'src/modal.test.tsx'] });
    codex.enqueueDirective({ action: 'declare_complete', reason: 'fixed and green' }, 'Good now.');
    planAnswers = ['y'];
    statusAfterBaseline(' M src/modal.tsx');
    runner.on(/pnpm test/, [
      { exitCode: 1, stdout: 'FAIL 1 test', failed: true },
      { exitCode: 0, stdout: 'PASS' },
    ]);

    const outcome = await makeOrchestrator().run('Build modal');

    expect(outcome.outcome).toBe('completed');
    expect(claude.invocations).toHaveLength(2); // initial + revision
    expect(claude.invocations[1]?.prompt).toContain('REVISION');
    expect(claude.invocations[1]?.prompt).toContain('Fix the failing test.');

    const taskDir = store().taskDir(outcome.taskId);
    const { events } = await readEventLog(join(taskDir, 'agency-log.ndjson'));
    expect(events.some((e) => e.actor === 'checks' && e.status === 'failed')).toBe(true);
    expect(events.some((e) => e.actor === 'claude' && e.action === 'revise')).toBe(true);
  });

  it('revision limit: stops blocked after maxRevisionLoopsPerPhase', async () => {
    config = ConfigSchema.parse({
      version: 1,
      limits: { maxRevisionLoopsPerPhase: 1, maxPhases: 6, maxTotalModelCalls: 20, maxRuntimeMinutes: 90 },
      checks: [],
    });
    codex.enqueueDirective({ action: 'delegate_to_claude', phase: 1, instructions: 'Build.' }, 'Plan.');
    claude.enqueueReport(1);
    codex.enqueueDirective({ action: 'request_claude_revision', phase: 1, instructions: 'Fix A.' });
    claude.enqueueReport(1);
    codex.enqueueDirective({ action: 'request_claude_revision', phase: 1, instructions: 'Fix B.' });
    planAnswers = ['y'];
    statusAfterBaseline(' M src/x.ts');

    const outcome = await makeOrchestrator().run('Build modal');

    expect(outcome.outcome).toBe('blocked');
    expect(claude.invocations).toHaveLength(2); // initial + 1 revision, second revision refused
    const report = await readText(outcome.reportPath!);
    expect(report).toContain('revision limit');
  });

  it('blocked path: codex stops blocked at triage', async () => {
    codex.enqueueDirective(
      { action: 'stop_blocked', reason: 'Task requires a database this repo does not have.' },
      'Cannot proceed.',
    );

    const outcome = await makeOrchestrator().run('Migrate the database');

    expect(outcome.outcome).toBe('blocked');
    expect(outcome.finalState).toBe('blocked');
    expect(claude.invocations).toHaveLength(0);
    const task = await store().getTask(outcome.taskId);
    expect(task.state).toBe('blocked');
    const report = await readText(outcome.reportPath!);
    expect(report).toContain('not safe to commit');
  });

  it('unsafe path: codex stops unsafe, outcome recorded', async () => {
    codex.enqueueDirective(
      { action: 'stop_unsafe', risk: 'high', reason: 'Task asks to delete production data.' },
      'Refusing.',
    );

    const outcome = await makeOrchestrator().run('Wipe the production database');

    expect(outcome.outcome).toBe('unsafe');
    expect(outcome.finalState).toBe('blocked');
    const task = await store().getTask(outcome.taskId);
    expect(task.outcome).toBe('unsafe');
    const taskDir = store().taskDir(outcome.taskId);
    const { events } = await readEventLog(join(taskDir, 'agency-log.ndjson'));
    expect(events.some((e) => e.action === 'stop_unsafe')).toBe(true);
  });

  it('invalid directive from codex: saves raw output and fails visibly', async () => {
    codex.enqueueRaw('I will just start refactoring everything now, trust me.');

    const outcome = await makeOrchestrator().run('Do something');

    expect(outcome.outcome).toBe('failed');
    const taskDir = store().taskDir(outcome.taskId);
    expect(await fileExists(join(taskDir, 'codex-triage-raw.txt'))).toBe(true);
    expect(await readText(join(taskDir, 'codex-triage-raw.txt'))).toContain('refactoring everything');
    const { events } = await readEventLog(join(taskDir, 'agency-log.ndjson'));
    expect(events.some((e) => e.action === 'triage' && e.status === 'failed')).toBe(true);
  });

  it('ask_user path: codex asks, user answers, codex proceeds to delegation', async () => {
    userAnswers = ['Use a modal, not a sidebar.'];
    planAnswers = ['y'];
    codex.enqueueDirective(
      { action: 'ask_user', question: 'Modal or sidebar?', reason: 'UX tradeoff needs a product decision' },
      'Plan pending decision.',
    );
    codex.enqueueDirective(
      { action: 'delegate_to_claude', phase: 1, instructions: 'Build a modal.' },
      'Proceeding with modal.',
    );
    claude.enqueueReport(1);
    codex.enqueueDirective({ action: 'declare_complete', reason: 'done' });
    statusAfterBaseline(' M src/modal.tsx');

    const outcome = await makeOrchestrator().run('Build shortcut helper UI');

    expect(outcome.outcome).toBe('completed');
    const taskDir = store().taskDir(outcome.taskId);
    const decisions = await readText(join(taskDir, 'user-decisions.md'));
    expect(decisions).toContain('Modal or sidebar?');
    expect(decisions).toContain('Use a modal, not a sidebar.');
  });

  it('ask_user with no interactive channel: pauses as awaiting_user_decision', async () => {
    userAnswers = []; // askUser returns null
    codex.enqueueDirective(
      { action: 'ask_user', question: 'Proceed with breaking API change?', reason: 'tradeoff' },
      'Need a decision.',
    );

    const outcome = await makeOrchestrator().run('Change API');

    expect(outcome.finalState).toBe('awaiting_user_decision');
    const task = await store().getTask(outcome.taskId);
    expect(task.state).toBe('awaiting_user_decision');
  });

  it('model call limit: stops blocked when maxTotalModelCalls is hit', async () => {
    config = ConfigSchema.parse({
      version: 1,
      limits: { maxTotalModelCalls: 1, maxPhases: 6, maxRevisionLoopsPerPhase: 3, maxRuntimeMinutes: 90 },
      checks: [],
    });
    codex.enqueueDirective({ action: 'delegate_to_claude', phase: 1, instructions: 'Build.' }, 'Plan.');
    claude.enqueueReport(1);
    planAnswers = ['y'];

    const outcome = await makeOrchestrator().run('Build modal');

    expect(outcome.outcome).toBe('blocked');
    const report = await readText(outcome.reportPath!);
    expect(report).toContain('limit');
  });

  it('claude invocation failure: task fails with report', async () => {
    codex.enqueueDirective({ action: 'delegate_to_claude', phase: 1, instructions: 'Build.' }, 'Plan.');
    claude.enqueue('', { ok: false });
    planAnswers = ['y'];

    const outcome = await makeOrchestrator().run('Build modal');

    expect(outcome.outcome).toBe('failed');
    expect(await fileExists(outcome.reportPath!)).toBe(true);
  });

  it('multi-phase: continue_next_phase starts phase 2 with its own artifacts', async () => {
    codex.enqueueDirective(
      { action: 'delegate_to_claude', phase: 1, instructions: 'Phase 1: build core.' },
      'Two-phase plan.',
    );
    claude.enqueueReport(1);
    codex.enqueueDirective(
      { action: 'continue_next_phase', phase: 2, instructions: 'Phase 2: add tests.', reason: 'phase 1 good' },
      'Phase 1 approved.',
    );
    claude.enqueueReport(2);
    codex.enqueueDirective({ action: 'declare_complete', reason: 'both phases done' });
    planAnswers = ['y'];
    statusAfterBaseline(' M src/core.ts');

    const outcome = await makeOrchestrator().run('Build feature in two phases');

    expect(outcome.outcome).toBe('completed');
    expect(claude.invocations).toHaveLength(2);
    const taskDir = store().taskDir(outcome.taskId);
    expect(await fileExists(join(taskDir, 'phase-001', 'codex-directive.json'))).toBe(true);
    expect(await fileExists(join(taskDir, 'phase-002', 'codex-directive.json'))).toBe(true);
  });

  describe('claude availability is only required at delegation time', () => {
    it('non-git preflight block never probes Claude', async () => {
      runner.on(/is-inside-work-tree/, { exitCode: 128, stdout: '' });

      const outcome = await makeOrchestrator().run('Build something');

      expect(outcome.outcome).toBe('blocked');
      expect(claude.availabilityChecks).toBe(0);
      expect(claude.invocations).toHaveLength(0);
    });

    it('dirty-tree preflight block never probes Claude', async () => {
      runner.on(/status --porcelain/, { stdout: ' M src/wip.ts' });

      const outcome = await makeOrchestrator().run('Build something');

      expect(outcome.outcome).toBe('blocked');
      expect(claude.availabilityChecks).toBe(0);
      expect(claude.invocations).toHaveLength(0);
    });

    it('codex self-edit path never probes Claude', async () => {
      codex.enqueueDirective(
        { action: 'self_edit', taskClass: 'quick_self_edit', risk: 'low', reason: 'tiny', instructions: 'Fix it.' },
        'Plan.',
      );
      codex.enqueueRaw('Fixed it.');
      codex.enqueueDirective({ action: 'declare_complete', reason: 'done' });
      statusAfterBaseline(' M README.md');

      const outcome = await makeOrchestrator().run('Fix typo');

      expect(outcome.outcome).toBe('completed');
      expect(claude.availabilityChecks).toBe(0);
      expect(claude.invocations).toHaveLength(0);
    });

    it('delegation fails visibly with a report when Claude is missing', async () => {
      codex.enqueueDirective(
        { action: 'delegate_to_claude', taskClass: 'single_phase_claude', phase: 1, instructions: 'Build it.' },
        'Plan.',
      );
      planAnswers = ['y'];
      claude.available = false;

      const outcome = await makeOrchestrator().run('Build a modal');

      expect(outcome.outcome).toBe('failed');
      expect(claude.invocations).toHaveLength(0); // never invoked
      expect(await fileExists(outcome.reportPath!)).toBe(true);
      const report = await readText(outcome.reportPath!);
      expect(report).toMatch(/Claude.*required for delegated implementation/i);
      const { events } = await readEventLog(join(store().taskDir(outcome.taskId), 'agency-log.ndjson'));
      expect(events.some((e) => e.action === 'delegate' && e.status === 'failed')).toBe(true);
    });
  });

  describe('review directive risk feeds the report', () => {
    function setupDelegationWithReviewRisk(risk: 'high' | 'medium'): void {
      codex.enqueueDirective(
        { action: 'delegate_to_claude', taskClass: 'single_phase_claude', phase: 1, instructions: 'Build it.' },
        'Plan.',
      );
      claude.enqueueReport(1);
      codex.enqueueDirective(
        { action: 'declare_complete', risk, reason: 'done but with concerns' },
        'Done, but flagging risk.',
      );
      planAnswers = ['y'];
      statusAfterBaseline(' M src/modal.tsx');
    }

    it('declare_complete with high review risk => not safe to commit', async () => {
      setupDelegationWithReviewRisk('high');

      const outcome = await makeOrchestrator().run('Build a modal');

      expect(outcome.outcome).toBe('completed');
      const report = await readText(outcome.reportPath!);
      expect(report).toContain('review was flagged high risk');
      expect(report).toContain('**not safe to commit**');
    });

    it('declare_complete with medium review risk => needs manual review', async () => {
      setupDelegationWithReviewRisk('medium');

      const outcome = await makeOrchestrator().run('Build a modal');

      expect(outcome.outcome).toBe('completed');
      const report = await readText(outcome.reportPath!);
      expect(report).toContain('review was flagged medium risk');
      expect(report).toContain('**needs manual review**');
    });
  });

  it('transitional check failure fixed by a later phase does not poison the verdict', async () => {
    // Live finding: phase 1 of a multi-phase rename legitimately broke the
    // check; phase 2 fixed it. The verdict must reflect the LATEST result
    // per check, not aggregate the historical failure forever.
    codex.enqueueDirective(
      { action: 'delegate_to_claude', phase: 1, instructions: 'Phase 1: rename in src only.', checksToRun: ['test'] },
      'Two-phase rename plan.',
    );
    claude.enqueueReport(1);
    codex.enqueueDirective(
      { action: 'continue_next_phase', phase: 2, instructions: 'Phase 2: update dependents.', reason: 'expected transitional failure', checksToRun: ['test'] },
      'Failure is transitional — continue.',
    );
    claude.enqueueReport(2);
    codex.enqueueDirective({ action: 'declare_complete', reason: 'rename complete, checks green' });
    planAnswers = ['y'];
    statusAfterBaseline(' M src/greet.js');
    runner.on(/pnpm test/, [
      { exitCode: 1, stdout: 'FAIL: welcome is not a function', failed: true },
      { exitCode: 0, stdout: 'PASS' },
    ]);

    const outcome = await makeOrchestrator().run('Rename welcome to salute');

    expect(outcome.outcome).toBe('completed');
    const report = await readText(outcome.reportPath!);
    expect(report).toContain('**safe to commit**');
    expect(report).not.toContain('check(s) failed');
    // The historical failure remains visible in the event timeline.
    const { events } = await readEventLog(join(store().taskDir(outcome.taskId), 'agency-log.ndjson'));
    expect(events.some((e) => e.actor === 'checks' && e.status === 'failed')).toBe(true);
  });

  it('unknown checksToRun names fall back to all configured checks, visibly', async () => {
    codex.enqueueDirective(
      { action: 'delegate_to_claude', phase: 1, instructions: 'Build.', checksToRun: ['npm test'] },
      'Plan.',
    );
    claude.enqueueReport(1);
    codex.enqueueDirective({ action: 'declare_complete', reason: 'done' });
    planAnswers = ['y'];
    statusAfterBaseline(' M src/x.ts');

    const outcome = await makeOrchestrator().run('Build something');

    expect(outcome.outcome).toBe('completed');
    const { events } = await readEventLog(join(store().taskDir(outcome.taskId), 'agency-log.ndjson'));
    expect(events.some((e) => e.message.includes('unknown check(s) npm test'))).toBe(true);
    // The configured check still ran (visible as 1 passed in the summary event).
    expect(events.some((e) => e.actor === 'checks' && e.message.includes('1 passed'))).toBe(true);
  });

  it('high-risk directive makes the report not safe to commit even when checks pass', async () => {
    codex.enqueueDirective(
      { action: 'delegate_to_claude', taskClass: 'single_phase_claude', phase: 1, risk: 'high', instructions: 'Touch auth flow.' },
      'Risky plan.',
    );
    claude.enqueueReport(1);
    codex.enqueueDirective({ action: 'declare_complete', reason: 'done' });
    planAnswers = ['y'];
    statusAfterBaseline(' M src/auth.ts');

    const outcome = await makeOrchestrator().run('Change auth');

    expect(outcome.outcome).toBe('completed');
    const report = await readText(outcome.reportPath!);
    expect(report).toContain('high risk');
    expect(report).toContain('**not safe to commit**');
  });
});

describe('requiresPlanApproval', () => {
  function directive(overrides: Record<string, unknown>) {
    return DirectiveSchema.parse({ actor: 'codex', reason: 'r', ...overrides });
  }

  it('requires approval for delegation, revision-before-work, continue, and high risk', () => {
    expect(requiresPlanApproval(directive({ action: 'delegate_to_claude' }))).toBe(true);
    expect(requiresPlanApproval(directive({ action: 'request_claude_revision' }))).toBe(true);
    expect(requiresPlanApproval(directive({ action: 'continue_next_phase' }))).toBe(true);
    expect(requiresPlanApproval(directive({ action: 'self_edit', risk: 'high', taskClass: 'quick_self_edit' }))).toBe(true);
  });

  it('requires approval for taskClass containing single_phase/multi_phase/claude/feature', () => {
    for (const taskClass of ['single_phase_claude', 'multi_phase', 'claude_heavy', 'feature_work']) {
      expect(requiresPlanApproval(directive({ action: 'self_edit', risk: 'low', taskClass }))).toBe(true);
    }
  });

  it('bypasses approval only for quick/trivial low-risk self-edit', () => {
    expect(requiresPlanApproval(directive({ action: 'self_edit', risk: 'low', taskClass: 'quick_self_edit' }))).toBe(false);
    expect(requiresPlanApproval(directive({ action: 'self_edit', risk: 'medium', taskClass: 'trivial_fix' }))).toBe(false);
    // No taskClass — be strict
    expect(requiresPlanApproval(directive({ action: 'self_edit', risk: 'low' }))).toBe(true);
  });

  it('never gates routing/stop actions', () => {
    expect(requiresPlanApproval(directive({ action: 'ask_user', risk: 'high' }))).toBe(false);
    expect(requiresPlanApproval(directive({ action: 'stop_blocked', risk: 'high' }))).toBe(false);
    expect(requiresPlanApproval(directive({ action: 'stop_unsafe', risk: 'high' }))).toBe(false);
  });
});
