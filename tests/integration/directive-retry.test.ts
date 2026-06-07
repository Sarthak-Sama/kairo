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
  MockHeadAdapter,
  MockDevLeadAdapter,
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

  function store(): TaskStore {
    return new TaskStore(join(repoRoot, '.kairo'));
  }

  beforeEach(async () => {
    repoRoot = await makeTempDir();
    await writeText(join(repoRoot, 'src', 'index.ts'), 'export const x = 1;\n');
    config = ConfigSchema.parse({ version: 1, checks: [] });
    head = new MockHeadAdapter();
    developmentLead = new MockDevLeadAdapter();
    runner = new MockProcessRunner();
    planAnswers = [];
    userAnswers = [];
  });

  afterEach(async () => {
    await cleanupDir(repoRoot);
  });

  it('invalid triage recovers on retry and the run continues', async () => {
    head.enqueueRaw('Plan prose without any JSON at all.');
    head.enqueueDirective(
      { action: 'self_edit', taskClass: 'quick_self_edit', risk: 'low', reason: 'tiny copy fix', instructions: 'Fix the typo.' },
      'Recovered plan.',
    );
    head.enqueueRaw('Edited the file.');
    head.enqueueDirective({ action: 'declare_complete', reason: 'done' });
    runner.on(/status --porcelain/, [{ stdout: '' }, { stdout: ' M README.md' }]);

    const outcome = await makeOrchestrator().run('Fix typo');

    expect(outcome.outcome).toBe('completed');
    const taskDir = store().taskDir(outcome.taskId);
    expect(await fileExists(join(taskDir, 'head-triage-invalid-attempt-1.txt'))).toBe(true);
    expect(head.invocations[1]?.purpose).toBe('triage-retry');
    expect(head.invocations[1]?.access).toBe('read');
    expect(head.invocations[1]?.prompt).toContain('failed directive validation');
    expect(head.invocations[1]?.prompt).toContain('Plan prose without any JSON');
    expect(head.invocations[1]?.prompt).toContain('"actor" MUST be present'); // full contract restated
    const { events } = await readEventLog(join(taskDir, 'agency-log.ndjson'));
    expect(events.some((e) => e.action === 'directive_retry' && e.status === 'completed')).toBe(true);
  });

  it('invalid review recovers on retry', async () => {
    head.enqueueDirective(
      { action: 'delegate_to_development_lead', phase: 1, instructions: 'Build it.' },
      'Plan.',
    );
    developmentLead.enqueueReport(1);
    head.enqueueRaw('Looks good to me! (forgot the directive)');
    head.enqueueDirective({ action: 'declare_complete', reason: 'matches plan' }, 'Reviewed.');
    planAnswers = ['y'];

    const outcome = await makeOrchestrator().run('Build modal');

    expect(outcome.outcome).toBe('completed');
    expect(head.invocations.map((i) => i.purpose)).toContain('review-phase-1-retry');
  });

  it('the dogfood case: invalid after-user-decision directive recovers on retry', async () => {
    head.enqueueDirective(
      { action: 'ask_user', question: 'Plans and pricing?', reason: 'product decision' },
      'Plan pending decision.',
    );
    userAnswers = ['Keep V1 interest-only, no payment.'];
    head.enqueueRaw(DOGFOOD_INVALID_RAW); // missing actor — the real failure
    head.enqueueDirective(
      { action: 'delegate_to_development_lead', phase: 1, instructions: 'Add the reassurance copy.' },
      'Re-emitted validly.',
    );
    planAnswers = ['y'];
    developmentLead.enqueueReport(1);
    head.enqueueDirective({ action: 'declare_complete', reason: 'done' });
    runner.on(/status --porcelain/, [{ stdout: '' }, { stdout: ' M src/form.tsx' }]);

    const outcome = await makeOrchestrator().run('Add paid enrollment CTA');

    expect(outcome.outcome).toBe('completed'); // previously: blocked
    expect(head.invocations.map((i) => i.purpose)).toContain('after-user-decision-retry');
    expect(developmentLead.invocations[0]?.prompt).toContain('Add the reassurance copy.');
  });

  it('retry failure still fails honestly with both raw artifacts saved', async () => {
    head.enqueueRaw('No JSON, attempt one.');
    head.enqueueRaw('No JSON, attempt two either.');

    const outcome = await makeOrchestrator().run('Do something');

    expect(outcome.outcome).toBe('failed');
    const taskDir = store().taskDir(outcome.taskId);
    expect(await readText(join(taskDir, 'head-triage-invalid-attempt-1.txt'))).toContain('attempt one');
    expect(await readText(join(taskDir, 'head-triage-invalid-attempt-2.txt'))).toContain('attempt two');
    expect(await fileExists(join(taskDir, 'head-triage-raw.txt'))).toBe(true); // existing failure artifact preserved
    const { events } = await readEventLog(join(taskDir, 'agency-log.ndjson'));
    expect(events.some((e) => e.action === 'directive_retry' && e.status === 'failed')).toBe(true);
  });

  it('does NOT retry invocation failures (quota/network/CLI errors) — only format failures', async () => {
    // Live regression evidence: a ChatGPT usage-limit exit-1 triggered a
    // pointless format-fix retry against the same quota wall.
    // Empty mock queue -> invoke() itself fails (ok: false).
    const outcome = await makeOrchestrator().run('Do something');

    expect(outcome.outcome).toBe('failed');
    expect(head.invocations).toHaveLength(1); // no second call
    const { events } = await readEventLog(join(store().taskDir(outcome.taskId), 'agency-log.ndjson'));
    expect(events.some((e) => e.action === 'directive_retry')).toBe(false);
    expect(events.some((e) => e.message.includes('not retrying (not a format problem)'))).toBe(true);
  });

  it('model-call limits still apply: no retry when the limit is already reached', async () => {
    config = ConfigSchema.parse({
      version: 1,
      checks: [],
      limits: { maxTotalModelCalls: 1, maxPhases: 6, maxRevisionLoopsPerPhase: 3, maxRuntimeMinutes: 90 },
    });
    head.enqueueRaw('Invalid triage output.');
    head.enqueueDirective({ action: 'declare_complete', reason: 'should never be consumed' });

    const outcome = await makeOrchestrator().run('Do something');

    expect(outcome.outcome).toBe('failed');
    expect(head.invocations).toHaveLength(1); // retry was skipped, not attempted
    const { events } = await readEventLog(join(store().taskDir(outcome.taskId), 'agency-log.ndjson'));
    expect(events.some((e) => e.action === 'directive_retry' && e.status === 'skipped')).toBe(true);
  });
});
