import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { EventLogger, followEventLog, type AgencyEvent } from '../../src/core/events.js';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { ConfigSchema, writeDefaultConfig } from '../../src/core/config.js';
import { statusCommand } from '../../src/commands/status.js';
import { inspectCommand } from '../../src/commands/inspect.js';
import { logsCommand } from '../../src/commands/logs.js';
import { writeText } from '../../src/utils/fs.js';
import {
  makeTempDir,
  cleanupDir,
  MockHeadAdapter,
  MockDevLeadAdapter,
  MockProcessRunner,
} from '../helpers/mocks.js';

describe('followEventLog (bounded)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await cleanupDir(dir);
  });

  it('emits existing events, then appended ones, and stops on isDone', async () => {
    const logPath = join(dir, 'agency-log.ndjson');
    const logger = new EventLogger(logPath);
    await logger.log({ actor: 'kairo', action: 'a', status: 'completed', message: '1' });
    await logger.log({ actor: 'head', action: 'b', status: 'started', message: '2' });

    const seen: string[] = [];
    let done = false;
    const followPromise = followEventLog(
      logPath,
      (e: AgencyEvent) => seen.push(e.message),
      { pollIntervalMs: 10, isDone: () => done },
    );

    // Append while following, then signal completion.
    await new Promise((r) => setTimeout(r, 30));
    await logger.log({ actor: 'development_lead', action: 'c', status: 'completed', message: '3' });
    await logger.log({ actor: 'kairo', action: 'd', status: 'completed', message: '4' });
    await new Promise((r) => setTimeout(r, 30));
    done = true;

    const delivered = await followPromise;
    expect(delivered).toBe(4);
    expect(seen).toEqual(['1', '2', '3', '4']); // in order, no re-emits
  });

  it('handles a log file that does not exist yet', async () => {
    const seen: string[] = [];
    let done = false;
    const promise = followEventLog(join(dir, 'missing.ndjson'), (e) => seen.push(e.message), {
      pollIntervalMs: 10,
      isDone: () => done,
    });
    await new Promise((r) => setTimeout(r, 25));
    done = true;
    expect(await promise).toBe(0);
    expect(seen).toEqual([]);
  });
});

describe('observability commands', () => {
  let repoRoot: string;
  let lines: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  /** Create a paused-at-decision task with one completed phase artifact set. */
  async function makePausedTask(): Promise<string> {
    const head = new MockHeadAdapter();
    head.enqueueDirective(
      { action: 'ask_user', question: 'Ship dark mode too?', reason: 'scope decision' },
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
    const outcome = await orchestrator.run('Add settings page');
    expect(outcome.finalState).toBe('awaiting_user_decision');
    return outcome.taskId;
  }

  beforeEach(async () => {
    repoRoot = await makeTempDir();
    await writeText(join(repoRoot, 'src', 'index.ts'), 'export {};\n');
    await writeDefaultConfig(repoRoot);
    lines = [];
    spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
  });

  afterEach(async () => {
    spy.mockRestore();
    await cleanupDir(repoRoot);
  });

  it('status shows state, last event, and a waiting-on-you marker', async () => {
    const taskId = await makePausedTask();
    await statusCommand(repoRoot);
    const output = lines.join('\n');
    expect(output).toContain(taskId);
    expect(output).toContain('awaiting_user_decision');
    expect(output).toContain('<< WAITING ON YOU');
    expect(output).toMatch(/last:\s+\[kairo\] pause/); // the actual latest event
    expect(output).toContain('awaiting user decision');
    expect(output).toContain('waiting on you:');
    expect(output).toContain(`kairo resume ${taskId}`);
  });

  it('inspect shows recent events and key artifact paths', async () => {
    const taskId = await makePausedTask();
    await inspectCommand(repoRoot, taskId);
    const output = lines.join('\n');
    expect(output).toContain('recent events');
    expect(output).toContain('ask_user');
    expect(output).toContain('key artifacts:');
    expect(output).toContain('report'); // pause writes a report
    expect(output).toContain('master plan');
    expect(output).toContain('pending:');
  });

  it('logs --follow on a waiting task prints events and stops immediately (bounded)', async () => {
    const taskId = await makePausedTask();
    await logsCommand(repoRoot, taskId, { follow: true }); // pending !== null -> isDone true on first check
    const output = lines.join('\n');
    expect(output).toContain('following');
    expect(output).toContain('task_created');
    expect(output).toContain('stopped following');
    expect(output).toContain('waiting on you');
  });
});
