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
  MockHeadAdapter,
  MockDevLeadAdapter,
  MockProcessRunner,
} from '../helpers/mocks.js';

describe('orchestrator (mocked adapters)', () => {
  let repoRoot: string;
  let config: KairoConfig;
  let head: MockHeadAdapter;
  let developmentLead: MockDevLeadAdapter;
  let runner: MockProcessRunner;
  let userAnswers: string[];
  let planAnswers: (string | null)[];
  let approveCalls: number;

  function makeOrchestrator(): Orchestrator {
    return new Orchestrator({
      config,
      repoRoot,
      head,
      developmentLead,
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
    head = new MockHeadAdapter();
    developmentLead = new MockDevLeadAdapter();
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
      expect(head.invocations).toHaveLength(0);
      expect(developmentLead.invocations).toHaveLength(0);
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
      expect(head.invocations).toHaveLength(0);
      expect(developmentLead.invocations).toHaveLength(0);
      const report = await readText(outcome.reportPath!);
      expect(report).toMatch(/commit or stash/i);
      expect(report).toContain('**not safe to commit**');
      // No stash/clean/commit was attempted
      expect(runner.commands.some((c) => /stash|clean|commit/.test(c))).toBe(false);
    });
  });

  describe('plan approval gate', () => {
    it('non-trivial delegation pauses as awaiting_plan_approval in non-interactive mode, before Claude', async () => {
      head.enqueueDirective(
        { action: 'delegate_to_development_lead', taskClass: 'single_phase_claude', phase: 1, instructions: 'Build it.' },
        '## Plan\nOne phase.',
      );
      planAnswers = [null]; // non-interactive

      const outcome = await makeOrchestrator().run('Build a modal');

      expect(outcome.finalState).toBe('awaiting_plan_approval');
      expect(developmentLead.invocations).toHaveLength(0);
      expect(head.invocations).toHaveLength(1); // triage only
      const task = await store().getTask(outcome.taskId);
      expect(task.state).toBe('awaiting_plan_approval');
      expect(await fileExists(outcome.reportPath!)).toBe(true);
      const decisions = await readText(join(store().taskDir(outcome.taskId), 'user-decisions.md'));
      expect(decisions).toContain('Plan approval requested');
    });

    it('approved plan continues to Claude', async () => {
      head.enqueueDirective(
        { action: 'delegate_to_development_lead', taskClass: 'single_phase_claude', phase: 1, instructions: 'Build it.' },
        'Plan.',
      );
      developmentLead.enqueueReport(1);
      head.enqueueDirective({ action: 'declare_complete', reason: 'done' });
      planAnswers = ['y'];
      statusAfterBaseline(' M src/modal.tsx');

      const outcome = await makeOrchestrator().run('Build a modal');

      expect(outcome.outcome).toBe('completed');
      expect(approveCalls).toBe(1);
      expect(developmentLead.invocations).toHaveLength(1);
      const task = await store().getTask(outcome.taskId);
      expect(task.stateHistory.map((h) => h.state)).toContain('awaiting_plan_approval');
      expect(task.stateHistory.map((h) => h.state)).toContain('planning_approved');
    });

    it('feedback re-invokes Codex and the revised directive is used (then approved)', async () => {
      head.enqueueDirective(
        { action: 'delegate_to_development_lead', taskClass: 'single_phase_claude', phase: 1, instructions: 'Build a big thing.' },
        'Big plan.',
      );
      // Codex's revision after feedback:
      head.enqueueDirective(
        { action: 'delegate_to_development_lead', taskClass: 'single_phase_claude', phase: 1, instructions: 'Build a smaller thing.' },
        'Smaller plan per feedback.',
      );
      developmentLead.enqueueReport(1);
      head.enqueueDirective({ action: 'declare_complete', reason: 'done' });
      planAnswers = ['Make it smaller in scope.', 'y'];
      statusAfterBaseline(' M src/modal.tsx');

      const outcome = await makeOrchestrator().run('Build a modal');

      expect(outcome.outcome).toBe('completed');
      expect(approveCalls).toBe(2);
      expect(head.invocations.map((i) => i.purpose)).toContain('plan-feedback');
      expect(developmentLead.invocations[0]?.prompt).toContain('Build a smaller thing.');
      const taskDir = store().taskDir(outcome.taskId);
      const decisions = await readText(join(taskDir, 'user-decisions.md'));
      expect(decisions).toContain('Make it smaller in scope.');
      // Revised plan prose replaced the master plan
      expect(await readText(join(taskDir, 'master-plan.md'))).toContain('Smaller plan per feedback.');
    });

    it('quick low-risk self-edit bypasses approval', async () => {
      head.enqueueDirective(
        { action: 'self_edit', taskClass: 'quick_self_edit', risk: 'low', reason: 'tiny fix', instructions: 'Fix the typo in README.md.' },
        'Plan: fix typo.',
      );
      head.enqueueRaw('Fixed the typo in README.md. One word changed.');
      head.enqueueDirective({ action: 'declare_complete', reason: 'done' });
      statusAfterBaseline(' M README.md');

      const outcome = await makeOrchestrator().run('Fix typo');

      expect(outcome.outcome).toBe('completed');
      expect(approveCalls).toBe(0); // gate bypassed
    });

    it('high-risk self-edit still requires approval', async () => {
      head.enqueueDirective(
        { action: 'self_edit', taskClass: 'quick_self_edit', risk: 'high', reason: 'touches auth', instructions: 'Edit auth config.' },
        'Plan.',
      );
      planAnswers = [null];

      const outcome = await makeOrchestrator().run('Tweak auth');

      expect(outcome.finalState).toBe('awaiting_plan_approval');
      expect(approveCalls).toBe(1);
      expect(head.invocations).toHaveLength(1); // no self-edit session ran
    });
  });

  describe('codex self-edit split', () => {
    it('self-edit runs a separate write-enabled Codex invocation; triage is read-only', async () => {
      head.enqueueDirective(
        { action: 'self_edit', taskClass: 'quick_self_edit', risk: 'low', reason: 'tiny', instructions: 'Fix the typo.' },
        'Plan.',
      );
      head.enqueueRaw('Edited README.md: fixed typo.');
      head.enqueueDirective({ action: 'declare_complete', reason: 'done' });
      statusAfterBaseline(' M README.md');

      const outcome = await makeOrchestrator().run('Fix typo');

      expect(outcome.outcome).toBe('completed');
      const purposes = head.invocations.map((i) => i.purpose);
      expect(purposes).toEqual(['triage', 'self-edit-phase-1', 'review-phase-1']);
      expect(head.invocations[0]?.access).toBe('read');
      expect(head.invocations[1]?.access).toBe('write');
      expect(head.invocations[2]?.access).toBe('read');

      const phaseDir = join(store().taskDir(outcome.taskId), 'phase-001');
      expect(await fileExists(join(phaseDir, 'head-self-edit-prompt.md'))).toBe(true);
      const transcript = await readText(join(phaseDir, 'head-self-edit-transcript.md'));
      expect(transcript).toContain('fixed typo');
    });

    it('self-edit producing no diff fails the run instead of continuing', async () => {
      head.enqueueDirective(
        { action: 'self_edit', taskClass: 'quick_self_edit', risk: 'low', reason: 'tiny', instructions: 'Fix it.' },
        'Plan.',
      );
      head.enqueueRaw('I made the edit (but actually changed nothing).');
      // status stays clean: baseline clean, post-self-edit clean

      const outcome = await makeOrchestrator().run('Fix typo');

      expect(outcome.outcome).toBe('failed');
      const report = await readText(outcome.reportPath!);
      expect(report).toContain('no working-tree changes');
      const { events } = await readEventLog(join(store().taskDir(outcome.taskId), 'agency-log.ndjson'));
      expect(events.some((e) => e.action === 'self_edit_verification' && e.status === 'failed')).toBe(true);
    });

    it('self-edit invocation failure fails the run visibly', async () => {
      head.enqueueDirective(
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
    head.enqueueDirective(
      {
        action: 'delegate_to_development_lead',
        taskClass: 'single_phase_claude',
        phase: 1,
        instructions: 'Build the modal component.',
        successCriteria: ['Modal opens via shortcut'],
        checksToRun: ['test'],
      },
      '## Master Plan\nOne phase: build modal.',
    );
    developmentLead.enqueueReport(1, { files: ['src/modal.tsx'] });
    head.enqueueDirective({ action: 'declare_complete', reason: 'matches plan' }, 'Reviewed. Clean diff.');
    planAnswers = ['y'];
    statusAfterBaseline(' M src/modal.tsx');
    runner.on(/^git diff HEAD/, { stdout: 'diff --git a/src/modal.tsx b/src/modal.tsx\n+modal' });

    const outcome = await makeOrchestrator().run('Build a keyboard shortcut helper modal');

    expect(outcome.outcome).toBe('completed');
    expect(developmentLead.invocations).toHaveLength(1);
    expect(developmentLead.invocations[0]?.prompt).toContain('Build the modal component.');
    expect(developmentLead.invocations[0]?.prompt).toContain('Do NOT commit');

    const taskDir = store().taskDir(outcome.taskId);
    const phaseDir = join(taskDir, 'phase-001');
    expect(await fileExists(join(phaseDir, 'development-lead-prompt.md'))).toBe(true);
    expect(await fileExists(join(phaseDir, 'development-lead-transcript.log'))).toBe(true);
    expect(await fileExists(join(phaseDir, 'development-lead-report.md'))).toBe(true);
    expect(await fileExists(join(phaseDir, 'diff.patch'))).toBe(true);
    expect(await fileExists(join(phaseDir, 'head-review.md'))).toBe(true);
    expect(await fileExists(join(phaseDir, 'head-decision.json'))).toBe(true);
    expect(await readText(join(phaseDir, 'diff.patch'))).toContain('src/modal.tsx');

    const { events } = await readEventLog(join(taskDir, 'agency-log.ndjson'));
    const actions = events.map((e) => `${e.actor}:${e.action}:${e.status}`);
    expect(actions).toContain('development_lead:implement:completed');
    expect(actions).toContain('checks:run_checks:completed');
    expect(actions).toContain('head:review:completed');

    // Transcript streamed via onChunk lands exactly once — no duplication
    // between chunk streaming and the buffered-fallback final write.
    const transcript = await readText(join(phaseDir, 'development-lead-transcript.log'));
    expect(transcript.match(/# Phase 1 Report/g)).toHaveLength(1);
    expect(transcript).not.toContain('(empty transcript)');

    // Clean baseline is reflected in the report
    const report = await readText(outcome.reportPath!);
    expect(report).toContain('clean working tree');
    expect(report).toContain('**safe to commit**');
  });

  it('failed check path: checks fail, codex requests revision, revision passes', async () => {
    head.enqueueDirective(
      { action: 'delegate_to_development_lead', taskClass: 'single_phase_claude', phase: 1, instructions: 'Build it.', checksToRun: ['test'] },
      'Plan.',
    );
    developmentLead.enqueueReport(1);
    head.enqueueDirective(
      { action: 'request_development_revision', phase: 1, instructions: 'Fix the failing test.', checksToRun: ['test'] },
      'Test failed — revise.',
    );
    developmentLead.enqueueReport(1, { files: ['src/modal.tsx', 'src/modal.test.tsx'] });
    head.enqueueDirective({ action: 'declare_complete', reason: 'fixed and green' }, 'Good now.');
    planAnswers = ['y'];
    statusAfterBaseline(' M src/modal.tsx');
    runner.on(/pnpm test/, [
      { exitCode: 1, stdout: 'FAIL 1 test', failed: true },
      { exitCode: 0, stdout: 'PASS' },
    ]);

    const outcome = await makeOrchestrator().run('Build modal');

    expect(outcome.outcome).toBe('completed');
    expect(developmentLead.invocations).toHaveLength(2); // initial + revision
    expect(developmentLead.invocations[1]?.prompt).toContain('REVISION');
    expect(developmentLead.invocations[1]?.prompt).toContain('Fix the failing test.');

    const taskDir = store().taskDir(outcome.taskId);
    const { events } = await readEventLog(join(taskDir, 'agency-log.ndjson'));
    expect(events.some((e) => e.actor === 'checks' && e.status === 'failed')).toBe(true);
    expect(events.some((e) => e.actor === 'development_lead' && e.action === 'revise')).toBe(true);
  });

  it('revision limit: stops blocked after maxRevisionLoopsPerPhase', async () => {
    config = ConfigSchema.parse({
      version: 1,
      limits: { maxRevisionLoopsPerPhase: 1, maxPhases: 6, maxTotalModelCalls: 20, maxRuntimeMinutes: 90 },
      checks: [],
    });
    head.enqueueDirective({ action: 'delegate_to_development_lead', phase: 1, instructions: 'Build.' }, 'Plan.');
    developmentLead.enqueueReport(1);
    head.enqueueDirective({ action: 'request_development_revision', phase: 1, instructions: 'Fix A.' });
    developmentLead.enqueueReport(1);
    head.enqueueDirective({ action: 'request_development_revision', phase: 1, instructions: 'Fix B.' });
    planAnswers = ['y'];
    statusAfterBaseline(' M src/x.ts');

    const outcome = await makeOrchestrator().run('Build modal');

    expect(outcome.outcome).toBe('blocked');
    expect(developmentLead.invocations).toHaveLength(2); // initial + 1 revision, second revision refused
    const report = await readText(outcome.reportPath!);
    expect(report).toContain('revision limit');
  });

  it('blocked path: codex stops blocked at triage', async () => {
    head.enqueueDirective(
      { action: 'stop_blocked', reason: 'Task requires a database this repo does not have.' },
      'Cannot proceed.',
    );

    const outcome = await makeOrchestrator().run('Migrate the database');

    expect(outcome.outcome).toBe('blocked');
    expect(outcome.finalState).toBe('blocked');
    expect(developmentLead.invocations).toHaveLength(0);
    const task = await store().getTask(outcome.taskId);
    expect(task.state).toBe('blocked');
    const report = await readText(outcome.reportPath!);
    expect(report).toContain('not safe to commit');
  });

  it('unsafe path: codex stops unsafe, outcome recorded', async () => {
    head.enqueueDirective(
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

  it('invalid directive from codex: retried once, then fails visibly with both raws saved', async () => {
    head.enqueueRaw('I will just start refactoring everything now, trust me.');
    head.enqueueRaw('Still no directive from me on the retry either.');

    const outcome = await makeOrchestrator().run('Do something');

    expect(outcome.outcome).toBe('failed');
    const taskDir = store().taskDir(outcome.taskId);
    expect(await readText(join(taskDir, 'head-triage-invalid-attempt-1.txt'))).toContain('refactoring everything');
    expect(await readText(join(taskDir, 'head-triage-raw.txt'))).toContain('Still no directive');
    const { events } = await readEventLog(join(taskDir, 'agency-log.ndjson'));
    expect(events.some((e) => e.action === 'triage' && e.status === 'failed')).toBe(true);
    expect(events.some((e) => e.action === 'directive_retry' && e.status === 'failed')).toBe(true);
  });

  it('ask_user path: codex asks, user answers, codex proceeds to delegation', async () => {
    userAnswers = ['Use a modal, not a sidebar.'];
    planAnswers = ['y'];
    head.enqueueDirective(
      { action: 'ask_user', question: 'Modal or sidebar?', reason: 'UX tradeoff needs a product decision' },
      'Plan pending decision.',
    );
    head.enqueueDirective(
      { action: 'delegate_to_development_lead', phase: 1, instructions: 'Build a modal.' },
      'Proceeding with modal.',
    );
    developmentLead.enqueueReport(1);
    head.enqueueDirective({ action: 'declare_complete', reason: 'done' });
    statusAfterBaseline(' M src/modal.tsx');

    const outcome = await makeOrchestrator().run('Build shortcut helper UI');

    expect(outcome.outcome).toBe('completed');
    const taskDir = store().taskDir(outcome.taskId);
    const decisions = await readText(join(taskDir, 'user-decisions.md'));
    expect(decisions).toContain('Modal or sidebar?');
    expect(decisions).toContain('Use a modal, not a sidebar.');
  });

  it('decision-amnesia regression: review and implementation context include prior user decisions', async () => {
    // Live dogfood finding (2/2 runs): the stateless reviewer re-asked an
    // already-answered product question because user decisions never reached
    // its prompt. They must now.
    userAnswers = ['Use a modal, not a sidebar.'];
    planAnswers = ['y'];
    head.enqueueDirective(
      { action: 'ask_user', question: 'Modal or sidebar?', reason: 'product decision' },
      'Plan pending decision.',
    );
    head.enqueueDirective(
      { action: 'delegate_to_development_lead', phase: 1, instructions: 'Build a modal.' },
      'Proceeding with modal.',
    );
    developmentLead.enqueueReport(1);
    head.enqueueDirective({ action: 'declare_complete', reason: 'done' });
    statusAfterBaseline(' M src/modal.tsx');

    const outcome = await makeOrchestrator().run('Build shortcut helper UI');

    expect(outcome.outcome).toBe('completed');
    const reviewPrompt = head.invocations.find((i) => i.purpose === 'review-phase-1')?.prompt ?? '';
    expect(reviewPrompt).toContain('## User Decisions Already Made');
    expect(reviewPrompt).toContain('Do not ask the same question again');
    expect(reviewPrompt).toContain('Modal or sidebar?');
    expect(reviewPrompt).toContain('Use a modal, not a sidebar.');
    // The implementer also gets the binding decisions.
    expect(developmentLead.invocations[0]?.prompt).toContain('Use a modal, not a sidebar.');
    // The after-decision Codex call carries earlier decisions too.
    const afterUserPrompt = head.invocations.find((i) => i.purpose === 'after-user-decision')?.prompt ?? '';
    expect(afterUserPrompt).toContain('## User Decisions Already Made');
  });

  it('ask_user with no interactive channel: pauses as awaiting_user_decision', async () => {
    userAnswers = []; // askUser returns null
    head.enqueueDirective(
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
    head.enqueueDirective({ action: 'delegate_to_development_lead', phase: 1, instructions: 'Build.' }, 'Plan.');
    developmentLead.enqueueReport(1);
    planAnswers = ['y'];

    const outcome = await makeOrchestrator().run('Build modal');

    expect(outcome.outcome).toBe('blocked');
    const report = await readText(outcome.reportPath!);
    expect(report).toContain('limit');
  });

  it('claude invocation failure: task fails with report', async () => {
    head.enqueueDirective({ action: 'delegate_to_development_lead', phase: 1, instructions: 'Build.' }, 'Plan.');
    developmentLead.enqueue('', { ok: false });
    planAnswers = ['y'];

    const outcome = await makeOrchestrator().run('Build modal');

    expect(outcome.outcome).toBe('failed');
    expect(await fileExists(outcome.reportPath!)).toBe(true);
  });

  it('multi-phase: continue_next_phase starts phase 2 with its own artifacts', async () => {
    head.enqueueDirective(
      { action: 'delegate_to_development_lead', phase: 1, instructions: 'Phase 1: build core.' },
      'Two-phase plan.',
    );
    developmentLead.enqueueReport(1);
    head.enqueueDirective(
      { action: 'continue_next_phase', phase: 2, instructions: 'Phase 2: add tests.', reason: 'phase 1 good' },
      'Phase 1 approved.',
    );
    developmentLead.enqueueReport(2);
    head.enqueueDirective({ action: 'declare_complete', reason: 'both phases done' });
    planAnswers = ['y'];
    statusAfterBaseline(' M src/core.ts');

    const outcome = await makeOrchestrator().run('Build feature in two phases');

    expect(outcome.outcome).toBe('completed');
    expect(developmentLead.invocations).toHaveLength(2);
    const taskDir = store().taskDir(outcome.taskId);
    expect(await fileExists(join(taskDir, 'phase-001', 'head-directive.json'))).toBe(true);
    expect(await fileExists(join(taskDir, 'phase-002', 'head-directive.json'))).toBe(true);
  });

  describe('claude availability is only required at delegation time', () => {
    it('non-git preflight block never probes Claude', async () => {
      runner.on(/is-inside-work-tree/, { exitCode: 128, stdout: '' });

      const outcome = await makeOrchestrator().run('Build something');

      expect(outcome.outcome).toBe('blocked');
      expect(developmentLead.availabilityChecks).toBe(0);
      expect(developmentLead.invocations).toHaveLength(0);
    });

    it('dirty-tree preflight block never probes Claude', async () => {
      runner.on(/status --porcelain/, { stdout: ' M src/wip.ts' });

      const outcome = await makeOrchestrator().run('Build something');

      expect(outcome.outcome).toBe('blocked');
      expect(developmentLead.availabilityChecks).toBe(0);
      expect(developmentLead.invocations).toHaveLength(0);
    });

    it('codex self-edit path never probes Claude', async () => {
      head.enqueueDirective(
        { action: 'self_edit', taskClass: 'quick_self_edit', risk: 'low', reason: 'tiny', instructions: 'Fix it.' },
        'Plan.',
      );
      head.enqueueRaw('Fixed it.');
      head.enqueueDirective({ action: 'declare_complete', reason: 'done' });
      statusAfterBaseline(' M README.md');

      const outcome = await makeOrchestrator().run('Fix typo');

      expect(outcome.outcome).toBe('completed');
      expect(developmentLead.availabilityChecks).toBe(0);
      expect(developmentLead.invocations).toHaveLength(0);
    });

    it('delegation fails visibly with a report when Claude is missing', async () => {
      head.enqueueDirective(
        { action: 'delegate_to_development_lead', taskClass: 'single_phase_claude', phase: 1, instructions: 'Build it.' },
        'Plan.',
      );
      planAnswers = ['y'];
      developmentLead.available = false;

      const outcome = await makeOrchestrator().run('Build a modal');

      expect(outcome.outcome).toBe('failed');
      expect(developmentLead.invocations).toHaveLength(0); // never invoked
      expect(await fileExists(outcome.reportPath!)).toBe(true);
      const report = await readText(outcome.reportPath!);
      expect(report).toMatch(/Claude.*required for delegated implementation/i);
      const { events } = await readEventLog(join(store().taskDir(outcome.taskId), 'agency-log.ndjson'));
      expect(events.some((e) => e.action === 'delegate' && e.status === 'failed')).toBe(true);
    });
  });

  describe('review directive risk feeds the report', () => {
    function setupDelegationWithReviewRisk(risk: 'high' | 'medium'): void {
      head.enqueueDirective(
        { action: 'delegate_to_development_lead', taskClass: 'single_phase_claude', phase: 1, instructions: 'Build it.' },
        'Plan.',
      );
      developmentLead.enqueueReport(1);
      head.enqueueDirective(
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
    head.enqueueDirective(
      { action: 'delegate_to_development_lead', phase: 1, instructions: 'Phase 1: rename in src only.', checksToRun: ['test'] },
      'Two-phase rename plan.',
    );
    developmentLead.enqueueReport(1);
    head.enqueueDirective(
      { action: 'continue_next_phase', phase: 2, instructions: 'Phase 2: update dependents.', reason: 'expected transitional failure', checksToRun: ['test'] },
      'Failure is transitional — continue.',
    );
    developmentLead.enqueueReport(2);
    head.enqueueDirective({ action: 'declare_complete', reason: 'rename complete, checks green' });
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
    head.enqueueDirective(
      { action: 'delegate_to_development_lead', phase: 1, instructions: 'Build.', checksToRun: ['npm test'] },
      'Plan.',
    );
    developmentLead.enqueueReport(1);
    head.enqueueDirective({ action: 'declare_complete', reason: 'done' });
    planAnswers = ['y'];
    statusAfterBaseline(' M src/x.ts');

    const outcome = await makeOrchestrator().run('Build something');

    expect(outcome.outcome).toBe('completed');
    const { events } = await readEventLog(join(store().taskDir(outcome.taskId), 'agency-log.ndjson'));
    expect(events.some((e) => e.message.includes('unknown check(s) npm test'))).toBe(true);
    // The configured check still ran (visible as 1 passed in the summary event).
    expect(events.some((e) => e.actor === 'checks' && e.message.includes('1 passed'))).toBe(true);
  });

  it('JSON-only review falls back to the decision reason in head-review.md', async () => {
    head.enqueueDirective(
      { action: 'delegate_to_development_lead', phase: 1, instructions: 'Build it.', checksToRun: ['test'] },
      'Plan.',
    );
    developmentLead.enqueueReport(1);
    // Review with NO prose: directive JSON only.
    head.enqueueDirective({ action: 'declare_complete', risk: 'low', reason: 'implementation matches the plan and checks pass' });
    planAnswers = ['y'];
    statusAfterBaseline(' M src/x.ts');

    const outcome = await makeOrchestrator().run('Build something');

    expect(outcome.outcome).toBe('completed');
    const review = await readText(join(store().taskDir(outcome.taskId), 'phase-001', 'head-review.md'));
    expect(review).toContain('(The head agent returned no separate review prose.)');
    expect(review).toContain('Decision: declare_complete');
    expect(review).toContain('Reason: implementation matches the plan and checks pass');
    expect(review).not.toBe('(no review prose)');
    // The fallback also reaches the final report's review section.
    const report = await readText(outcome.reportPath!);
    expect(report).toContain('Decision: declare_complete');
  });

  describe('unrun configured checks in reports', () => {
    function multiCheckConfig(): KairoConfig {
      return ConfigSchema.parse({
        version: 1,
        checks: [
          { name: 'typecheck', command: 'npx tsc --noEmit' },
          { name: 'lint', command: 'npm run lint' },
          { name: 'test', command: 'npm run test' },
          { name: 'build', command: 'npm run build' },
        ],
      });
    }

    it('full suite run and passing → safe to commit, no NOT RUN lines', async () => {
      config = multiCheckConfig();
      head.enqueueDirective(
        { action: 'delegate_to_development_lead', phase: 1, instructions: 'Build.', checksToRun: [] }, // empty = all
        'Plan.',
      );
      developmentLead.enqueueReport(1);
      head.enqueueDirective({ action: 'declare_complete', reason: 'done' }, 'Reviewed, no blockers here.');
      planAnswers = ['y'];
      statusAfterBaseline(' M src/x.ts');

      const outcome = await makeOrchestrator().run('Build something');
      const report = await readText(outcome.reportPath!);
      expect(report).not.toContain('NOT RUN');
      expect(report).toContain('**safe to commit**');
    });

    it('subset run → unrun checks listed and needs manual review', async () => {
      config = multiCheckConfig();
      head.enqueueDirective(
        { action: 'delegate_to_development_lead', phase: 1, instructions: 'Build.', checksToRun: ['typecheck', 'test'] },
        'Plan.',
      );
      developmentLead.enqueueReport(1);
      head.enqueueDirective({ action: 'declare_complete', reason: 'done' }, 'Reviewed, no blockers here.');
      planAnswers = ['y'];
      statusAfterBaseline(' M src/x.ts');

      const outcome = await makeOrchestrator().run('Build something');
      const report = await readText(outcome.reportPath!);
      expect(report).toContain('- **lint**: NOT RUN');
      expect(report).toContain('- **build**: NOT RUN');
      expect(report).toContain('never ran for this task (lint, build)');
      expect(report).toContain('**needs manual review**');
    });

    it('a later full-suite run_checks restores the safe recommendation', async () => {
      config = multiCheckConfig();
      head.enqueueDirective(
        { action: 'delegate_to_development_lead', phase: 1, instructions: 'Build.', checksToRun: ['test'] },
        'Plan.',
      );
      developmentLead.enqueueReport(1);
      head.enqueueDirective(
        { action: 'run_checks', reason: 'verify the full suite before closing', checksToRun: [] }, // all
        'Want full verification.',
      );
      head.enqueueDirective({ action: 'declare_complete', reason: 'done' }, 'Reviewed, no blockers here.');
      planAnswers = ['y'];
      statusAfterBaseline(' M src/x.ts');

      const outcome = await makeOrchestrator().run('Build something');
      const report = await readText(outcome.reportPath!);
      expect(report).not.toContain('NOT RUN');
      expect(report).toContain('**safe to commit**');
    });
  });

  describe('operating profile metadata', () => {
    it('task.json stores profile and team; report carries the Operating Profile section', async () => {
      head = new MockHeadAdapter('claude');
      developmentLead = new MockDevLeadAdapter('claude');
      head.enqueueDirective(
        { action: 'delegate_to_development_lead', phase: 1, instructions: 'Build.', checksToRun: ['test'] },
        'Plan.',
      );
      developmentLead.enqueueReport(1);
      head.enqueueDirective({ action: 'declare_complete', reason: 'done' });
      planAnswers = ['y'];
      statusAfterBaseline(' M src/x.ts');

      const orchestrator = new Orchestrator({
        config,
        repoRoot,
        head,
        developmentLead,
        runner,
        askUser: async () => userAnswers.shift() ?? null,
        approvePlan: async () => planAnswers.shift() ?? null,
        profileName: 'daily',
      });
      const outcome = await orchestrator.run('Build something');

      expect(outcome.outcome).toBe('completed');
      const task = await store().getTask(outcome.taskId);
      expect(task.profile).toBe('daily');
      expect(task.team).toEqual({ head: 'claude', developmentLead: 'claude' });
      const report = await readText(outcome.reportPath!);
      expect(report).toContain('## Operating Profile');
      expect(report).toContain('- Profile: daily');
      expect(report).toContain('- Head planner/reviewer: claude');
      expect(report).toContain('- Development lead: claude');
    });

    it('no profile: task stores null profile and the current team; report says none', async () => {
      head.enqueueDirective({ action: 'stop_blocked', reason: 'nope' });

      const outcome = await makeOrchestrator().run('Blocked task');

      const task = await store().getTask(outcome.taskId);
      expect(task.profile).toBeNull();
      expect(task.team).toEqual({ head: 'codex', developmentLead: 'claude' });
      const report = await readText(outcome.reportPath!);
      expect(report).toContain('- Profile: none');
    });

    it('triage prompt names the resolved development-lead provider', async () => {
      developmentLead = new MockDevLeadAdapter('codex');
      head.enqueueDirective({ action: 'stop_blocked', reason: 'just checking the prompt' });

      await makeOrchestrator().run('Anything');

      expect(head.invocations[0]?.prompt).toContain('the development lead is codex');
    });
  });

  it('high-risk directive makes the report not safe to commit even when checks pass', async () => {
    head.enqueueDirective(
      { action: 'delegate_to_development_lead', taskClass: 'single_phase_claude', phase: 1, risk: 'high', instructions: 'Touch auth flow.' },
      'Risky plan.',
    );
    developmentLead.enqueueReport(1);
    head.enqueueDirective({ action: 'declare_complete', reason: 'done' });
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
    expect(requiresPlanApproval(directive({ action: 'delegate_to_development_lead' }))).toBe(true);
    expect(requiresPlanApproval(directive({ action: 'request_development_revision' }))).toBe(true);
    expect(requiresPlanApproval(directive({ action: 'continue_next_phase' }))).toBe(true);
    expect(requiresPlanApproval(directive({ action: 'self_edit', risk: 'high', taskClass: 'quick_self_edit' }))).toBe(true);
  });

  it('requires approval for taskClass containing single_phase/multi_phase/claude/feature', () => {
    for (const taskClass of ['single_phase_claude', 'multi_phase', 'claude_heavy', 'feature_work']) {
      expect(requiresPlanApproval(directive({ action: 'self_edit', risk: 'low', taskClass }))).toBe(true);
    }
  });

  it('bypasses approval only for genuinely tiny low-risk self-edits', () => {
    // typo/readme/copy-only changes bypass
    expect(requiresPlanApproval(directive({
      action: 'self_edit', risk: 'low', taskClass: 'quick_self_edit',
      reason: 'one-word typo', instructions: 'Fix the typo in README.md.',
    }))).toBe(false);
    expect(requiresPlanApproval(directive({
      action: 'self_edit', risk: 'low', taskClass: 'trivial_copy_change',
      reason: 'marquee copy tweak', instructions: 'Change the marquee string in app/marquee-data.ts.',
    }))).toBe(false);
    // No taskClass — be strict
    expect(requiresPlanApproval(directive({ action: 'self_edit', risk: 'low' }))).toBe(true);
    // Medium risk no longer bypasses (was allowed before dogfood)
    expect(requiresPlanApproval(directive({ action: 'self_edit', risk: 'medium', taskClass: 'trivial_fix' }))).toBe(true);
  });

  it('dogfood regression: feature-shaped self-edits no longer bypass the gate', () => {
    // The Career Combini case: a full UI feature labeled quick_self_edit.
    expect(requiresPlanApproval(directive({
      action: 'self_edit', risk: 'low', taskClass: 'quick_self_edit',
      reason: 'small and tightly scoped to the home page',
      instructions: 'Add a client component for the receipt-style overlay and mount it from app/page.tsx.',
    }))).toBe(true);
    // new component
    expect(requiresPlanApproval(directive({
      action: 'self_edit', risk: 'low', taskClass: 'quick_self_edit',
      reason: 'add a small component', instructions: 'Create a new component for the banner.',
    }))).toBe(true);
    // modal/dialog/overlay
    for (const word of ['modal', 'dialog', 'overlay']) {
      expect(requiresPlanApproval(directive({
        action: 'self_edit', risk: 'low', taskClass: 'quick_self_edit',
        reason: `add a ${word}`, instructions: `Build the ${word} markup.`,
      }))).toBe(true);
    }
    // new route/page
    expect(requiresPlanApproval(directive({
      action: 'self_edit', risk: 'low', taskClass: 'quick_self_edit',
      reason: 'add a route', instructions: 'Add a new page at /tools/x.',
    }))).toBe(true);
    // high risk
    expect(requiresPlanApproval(directive({
      action: 'self_edit', risk: 'high', taskClass: 'quick_self_edit',
      reason: 'tiny', instructions: 'Edit one string.',
    }))).toBe(true);
  });

  it('never gates routing/stop actions', () => {
    expect(requiresPlanApproval(directive({ action: 'ask_user', risk: 'high' }))).toBe(false);
    expect(requiresPlanApproval(directive({ action: 'stop_blocked', risk: 'high' }))).toBe(false);
    expect(requiresPlanApproval(directive({ action: 'stop_unsafe', risk: 'high' }))).toBe(false);
  });
});
