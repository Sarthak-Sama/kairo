import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { ConfigSchema, type KairoConfig } from '../../src/core/config.js';
import { TaskStore } from '../../src/core/task-store.js';
import { readEventLog } from '../../src/core/events.js';
import { fileExists, readText, writeText } from '../../src/utils/fs.js';
import {
  makeTempDir,
  cleanupDir,
  MockCodexAdapter,
  MockClaudeAdapter,
  MockProcessRunner,
} from '../helpers/mocks.js';

/**
 * Dogfood regression (Career Combini Task 3): Codex produced a substantively
 * correct directive that merely omitted the required `actor` field, and the
 * run blocked. The exact raw shape from that failure:
 */
const DOGFOOD_INVALID_RAW = `The user reversed the original product direction: V1 must stay interest-only.

\`\`\`json
{
  "action": "delegate_to_claude",
  "reason": "The task scope changed from paid enrollment to a small V1 interest-only reassurance update.",
  "instructions": "Update the course detail page interest form area to clearly state that submitting interest is not enrollment."
}
\`\`\``;

describe('one-shot directive retry (mocked adapters)', () => {
  let repoRoot: string;
  let config: KairoConfig;
  let codex: MockCodexAdapter;
  let claude: MockClaudeAdapter;
  let runner: MockProcessRunner;
  let planAnswers: (string | null)[];
  let userAnswers: (string | null)[];

  function makeOrchestrator(): Orchestrator {
    return new Orchestrator({
      config,
      repoRoot,
      codex,
      claude,
      runner,
      askUser: async () => userAnswers.shift() ?? null,
      approvePlan: async () => planAnswers.shift() ?? null,
    });
  }

  function store(): TaskStore {
    return new TaskStore(join(repoRoot, '.kairo'));
  }

  beforeEach(async () => {
    repoRoot = await makeTempDir();
    await writeText(join(repoRoot, 'src', 'index.ts'), 'export const x = 1;\n');
    config = ConfigSchema.parse({ version: 1, checks: [] });
    codex = new MockCodexAdapter();
    claude = new MockClaudeAdapter();
    runner = new MockProcessRunner();
    planAnswers = [];
    userAnswers = [];
  });

  afterEach(async () => {
    await cleanupDir(repoRoot);
  });

  it('invalid triage recovers on retry and the run continues', async () => {
    codex.enqueueRaw('Plan prose without any JSON at all.');
    codex.enqueueDirective(
      { action: 'self_edit', taskClass: 'quick_self_edit', risk: 'low', reason: 'tiny copy fix', instructions: 'Fix the typo.' },
      'Recovered plan.',
    );
    codex.enqueueRaw('Edited the file.');
    codex.enqueueDirective({ action: 'declare_complete', reason: 'done' });
    runner.on(/status --porcelain/, [{ stdout: '' }, { stdout: ' M README.md' }]);

    const outcome = await makeOrchestrator().run('Fix typo');

    expect(outcome.outcome).toBe('completed');
    const taskDir = store().taskDir(outcome.taskId);
    expect(await fileExists(join(taskDir, 'codex-triage-invalid-attempt-1.txt'))).toBe(true);
    expect(codex.invocations[1]?.purpose).toBe('triage-retry');
    expect(codex.invocations[1]?.sandbox).toBe('read-only');
    expect(codex.invocations[1]?.prompt).toContain('failed directive validation');
    expect(codex.invocations[1]?.prompt).toContain('Plan prose without any JSON');
    expect(codex.invocations[1]?.prompt).toContain('"actor" MUST be present'); // full contract restated
    const { events } = await readEventLog(join(taskDir, 'agency-log.ndjson'));
    expect(events.some((e) => e.action === 'directive_retry' && e.status === 'completed')).toBe(true);
  });

  it('invalid review recovers on retry', async () => {
    codex.enqueueDirective(
      { action: 'delegate_to_claude', phase: 1, instructions: 'Build it.' },
      'Plan.',
    );
    claude.enqueueReport(1);
    codex.enqueueRaw('Looks good to me! (forgot the directive)');
    codex.enqueueDirective({ action: 'declare_complete', reason: 'matches plan' }, 'Reviewed.');
    planAnswers = ['y'];

    const outcome = await makeOrchestrator().run('Build modal');

    expect(outcome.outcome).toBe('completed');
    expect(codex.invocations.map((i) => i.purpose)).toContain('review-phase-1-retry');
  });

  it('the dogfood case: invalid after-user-decision directive recovers on retry', async () => {
    codex.enqueueDirective(
      { action: 'ask_user', question: 'Plans and pricing?', reason: 'product decision' },
      'Plan pending decision.',
    );
    userAnswers = ['Keep V1 interest-only, no payment.'];
    codex.enqueueRaw(DOGFOOD_INVALID_RAW); // missing actor — the real failure
    codex.enqueueDirective(
      { action: 'delegate_to_claude', phase: 1, instructions: 'Add the reassurance copy.' },
      'Re-emitted validly.',
    );
    planAnswers = ['y'];
    claude.enqueueReport(1);
    codex.enqueueDirective({ action: 'declare_complete', reason: 'done' });
    runner.on(/status --porcelain/, [{ stdout: '' }, { stdout: ' M src/form.tsx' }]);

    const outcome = await makeOrchestrator().run('Add paid enrollment CTA');

    expect(outcome.outcome).toBe('completed'); // previously: blocked
    expect(codex.invocations.map((i) => i.purpose)).toContain('after-user-decision-retry');
    expect(claude.invocations[0]?.prompt).toContain('Add the reassurance copy.');
  });

  it('retry failure still fails honestly with both raw artifacts saved', async () => {
    codex.enqueueRaw('No JSON, attempt one.');
    codex.enqueueRaw('No JSON, attempt two either.');

    const outcome = await makeOrchestrator().run('Do something');

    expect(outcome.outcome).toBe('failed');
    const taskDir = store().taskDir(outcome.taskId);
    expect(await readText(join(taskDir, 'codex-triage-invalid-attempt-1.txt'))).toContain('attempt one');
    expect(await readText(join(taskDir, 'codex-triage-invalid-attempt-2.txt'))).toContain('attempt two');
    expect(await fileExists(join(taskDir, 'codex-triage-raw.txt'))).toBe(true); // existing failure artifact preserved
    const { events } = await readEventLog(join(taskDir, 'agency-log.ndjson'));
    expect(events.some((e) => e.action === 'directive_retry' && e.status === 'failed')).toBe(true);
  });

  it('model-call limits still apply: no retry when the limit is already reached', async () => {
    config = ConfigSchema.parse({
      version: 1,
      checks: [],
      limits: { maxTotalModelCalls: 1, maxPhases: 6, maxRevisionLoopsPerPhase: 3, maxRuntimeMinutes: 90 },
    });
    codex.enqueueRaw('Invalid triage output.');
    codex.enqueueDirective({ action: 'declare_complete', reason: 'should never be consumed' });

    const outcome = await makeOrchestrator().run('Do something');

    expect(outcome.outcome).toBe('failed');
    expect(codex.invocations).toHaveLength(1); // retry was skipped, not attempted
    const { events } = await readEventLog(join(store().taskDir(outcome.taskId), 'agency-log.ndjson'));
    expect(events.some((e) => e.action === 'directive_retry' && e.status === 'skipped')).toBe(true);
  });
});
