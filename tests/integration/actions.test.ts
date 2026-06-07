import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { askAction, noteAction, stopAction } from '../../src/core/actions.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { ConfigSchema, type KairoConfig } from '../../src/core/config.js';
import { TaskStore } from '../../src/core/task-store.js';
import { readJson, readText, writeJson, writeText } from '../../src/utils/fs.js';
import {
  makeTempDir,
  cleanupDir,
  MockHeadAdapter,
  MockDevLeadAdapter,
  MockProcessRunner,
} from '../helpers/mocks.js';

/**
 * The extracted action functions power both the CLI commands and the TUI;
 * they must keep the exact command semantics.
 */
describe('shared action functions', () => {
  let repoRoot: string;

  /** Real config on disk (actions load it like the commands do). */
  async function writeConfig(overrides: { codexCommand?: string; claudeCommand?: string } = {}): Promise<void> {
    const config: KairoConfig = ConfigSchema.parse({
      version: 1,
      checks: [],
      codex: { command: overrides.codexCommand ?? 'echo' },
      claude: { command: overrides.claudeCommand ?? 'echo' },
    });
    await writeJson(join(repoRoot, '.kairo', 'config.json'), config);
  }

  async function pauseAtPlanApproval(): Promise<string> {
    const head = new MockHeadAdapter();
    head.enqueueDirective(
      { action: 'delegate_to_development_lead', taskClass: 'single_phase_dev', phase: 1, instructions: 'Build it.' },
      'Plan.',
    );
    const orchestrator = new Orchestrator({
      config: ConfigSchema.parse({ version: 1, checks: [] }),
      repoRoot,
      head,
      developmentLead: new MockDevLeadAdapter(),
      runner: new MockProcessRunner(),
      askUser: async () => null,
      approvePlan: async () => null,
    });
    const outcome = await orchestrator.run('Build a modal');
    expect(outcome.finalState).toBe('awaiting_plan_approval');
    return outcome.taskId;
  }

  function store(): TaskStore {
    return new TaskStore(join(repoRoot, '.kairo'));
  }

  beforeEach(async () => {
    repoRoot = await makeTempDir();
    await writeText(join(repoRoot, 'src', 'index.ts'), 'export {};\n');
    await writeConfig();
  });

  afterEach(async () => {
    await cleanupDir(repoRoot);
  });

  it('askAction with "y" consumes the pending plan-approval checkpoint (the TUI approve path)', async () => {
    const taskId = await pauseAtPlanApproval();
    // Development lead missing -> continuation fails AFTER the approval
    // consumed the checkpoint; that still counts as handled.
    await writeConfig({ claudeCommand: 'definitely-missing-claude-xyz' });

    const result = await askAction(repoRoot, taskId, 'y');

    expect(result.status).toBe('done');
    const task = await store().getTask(taskId);
    expect(task.pending).toBeNull(); // checkpoint consumed
    const audit = await readText(join(store().taskDir(taskId), 'user-messages.ndjson'));
    expect(JSON.parse(audit.trim().split('\n')[0]!).handled).toBe(true);
  });

  it('askAction with a message reports no-pending for idle tasks', async () => {
    await store().createTask({ id: 'idle-task', title: 'x', repoRoot });

    const result = await askAction(repoRoot, 'idle-task', 'some message');

    expect(result).toEqual({ status: 'no-pending', taskId: 'idle-task', state: 'created' });
    const audit = await readText(join(store().taskDir('idle-task'), 'user-messages.ndjson'));
    expect(JSON.parse(audit.trim().split('\n')[0]!).handled).toBe(false);
  });

  it('noteAction records a note WITHOUT consuming the pending checkpoint', async () => {
    const taskId = await pauseAtPlanApproval();

    const result = await noteAction(repoRoot, taskId, 'Keep it copy-only.');

    expect(result.stillPending).toBe(true);
    expect(result.pendingKind).toBe('plan_approval');
    const task = await store().getTask(taskId);
    expect(task.pending?.kind).toBe('plan_approval'); // untouched
    expect(await readText(join(store().taskDir(taskId), 'manager-notes.md'))).toContain('Keep it copy-only.');
  });

  it('stopAction finalizes paused tasks and writes the control signal', async () => {
    const taskId = await pauseAtPlanApproval();

    const outcome = await stopAction(repoRoot, taskId, 'TUI stop test');

    expect(outcome.outcome).toBe('stopped_by_user');
    const control = await readJson<{ stopRequested: boolean; reason: string }>(
      join(store().taskDir(taskId), 'control.json'),
    );
    expect(control).toMatchObject({ stopRequested: true, reason: 'TUI stop test' });
    const task = await store().getTask(taskId);
    expect(task.state).toBe('blocked');
    expect(task.pending).toBeNull();
  });

  it('stopAction throws on terminal tasks (same as the command)', async () => {
    const taskId = await pauseAtPlanApproval();
    await stopAction(repoRoot, taskId, 'first stop');

    await expect(stopAction(repoRoot, taskId, 'again')).rejects.toThrow(/terminal tasks cannot be stopped/);
  });
});
