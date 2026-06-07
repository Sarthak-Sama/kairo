import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { askCommand } from '../../src/commands/ask.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { ConfigSchema, type KairoConfig } from '../../src/core/config.js';
import { TaskStore } from '../../src/core/task-store.js';
import { fileExists, readText, writeJson, writeText } from '../../src/utils/fs.js';
import {
  makeTempDir,
  cleanupDir,
  MockHeadAdapter,
  MockDevLeadAdapter,
  MockProcessRunner,
} from '../helpers/mocks.js';

/**
 * Regression tests for the ask audit bug: user-messages.ndjson must only say
 * `handled: true` when the pending checkpoint was actually consumed.
 */
describe('kairo ask audit honesty', () => {
  let repoRoot: string;
  let savedExitCode: typeof process.exitCode;

  /** Write a real .kairo/config.json (askCommand loads config from disk). */
  async function writeConfig(overrides: { codexCommand?: string; claudeCommand?: string }): Promise<void> {
    const config: KairoConfig = ConfigSchema.parse({
      version: 1,
      checks: [],
      codex: { command: overrides.codexCommand ?? 'echo' },
      claude: { command: overrides.claudeCommand ?? 'echo' },
    });
    await writeJson(join(repoRoot, '.kairo', 'config.json'), config);
  }

  /** Pause a task at plan approval using mocked adapters; returns the task id. */
  async function pauseAtPlanApproval(): Promise<string> {
    const head = new MockHeadAdapter();
    head.enqueueDirective(
      { action: 'delegate_to_development_lead', taskClass: 'single_phase_claude', phase: 1, instructions: 'Build it.' },
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

  function messagesPath(taskId: string): string {
    return join(repoRoot, '.kairo', 'tasks', taskId, 'user-messages.ndjson');
  }

  async function readMessages(taskId: string): Promise<Array<{ message: string; handled: boolean; reason?: string }>> {
    const raw = await readText(messagesPath(taskId));
    return raw.trim().split('\n').map((l) => JSON.parse(l));
  }

  beforeEach(async () => {
    repoRoot = await makeTempDir();
    await writeText(join(repoRoot, 'src', 'index.ts'), 'export const x = 1;\n');
    savedExitCode = process.exitCode;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = savedExitCode;
    await cleanupDir(repoRoot);
  });

  it('non-paused task records the message as NOT handled', async () => {
    await writeConfig({});
    const store = new TaskStore(join(repoRoot, '.kairo'));
    await store.createTask({ id: 'idle-task', title: 'x', repoRoot });

    await askCommand(repoRoot, 'idle-task', 'a note for later');

    const [line] = await readMessages('idle-task');
    expect(line?.handled).toBe(false);
    expect(line?.reason).toContain('no pending decision');
    expect(line?.message).toBe('a note for later');
  });

  it('paused task + missing Codex records NOT handled', async () => {
    const taskId = await pauseAtPlanApproval();
    await writeConfig({ codexCommand: 'definitely-missing-codex-xyz' });

    await askCommand(repoRoot, taskId, 'y');

    const [line] = await readMessages(taskId);
    expect(line?.handled).toBe(false);
    expect(line?.reason).toContain('head agent');
    // Pending checkpoint untouched.
    const task = await new TaskStore(join(repoRoot, '.kairo')).getTask(taskId);
    expect(task.pending?.kind).toBe('plan_approval');
  });

  it('paused task + dirty-tree resume refusal records NOT handled', async () => {
    // Real git repo whose working tree becomes dirty before the ask.
    execSync(
      'git init -q && git config user.email t@t.t && git config user.name t && git add -A && git commit -qm base',
      { cwd: repoRoot },
    );
    const taskId = await pauseAtPlanApproval(); // mocked pause; no phases ran
    await writeConfig({}); // codex resolves to `echo`, which exists
    await writeText(join(repoRoot, 'src', 'wip.ts'), '// uncommitted user work\n');

    await askCommand(repoRoot, taskId, 'y');
    expect(process.exitCode).toBe(1); // refusal reported via exit code now

    const [line] = await readMessages(taskId);
    expect(line?.handled).toBe(false);
    expect(line?.reason).toContain('resume refused');
    const task = await new TaskStore(join(repoRoot, '.kairo')).getTask(taskId);
    expect(task.pending?.kind).toBe('plan_approval'); // still resumable
  });

  it('successful ask (pending checkpoint consumed) records handled: true', async () => {
    const taskId = await pauseAtPlanApproval();
    // Codex resolves (echo); Claude missing — the continuation will fail
    // AFTER the approval consumed the checkpoint, which still counts as
    // handled: the message was applied.
    await writeConfig({ claudeCommand: 'definitely-missing-claude-xyz' });

    await askCommand(repoRoot, taskId, 'y');

    const [line] = await readMessages(taskId);
    expect(line?.handled).toBe(true);
    expect(line?.reason).toBeUndefined();
    const task = await new TaskStore(join(repoRoot, '.kairo')).getTask(taskId);
    expect(task.pending).toBeNull(); // checkpoint really was consumed
    expect(task.state).toBe('failed'); // honest: continuation failed afterwards
  });

  it('never writes a premature line: the audit file does not exist before the outcome is known', async () => {
    const taskId = await pauseAtPlanApproval();
    expect(await fileExists(messagesPath(taskId))).toBe(false);
  });
});
