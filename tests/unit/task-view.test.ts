import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { listTaskViews, loadTaskView } from '../../src/core/task-view.js';
import { TaskStore } from '../../src/core/task-store.js';
import { EventLogger } from '../../src/core/events.js';
import { appendText, writeText } from '../../src/utils/fs.js';
import { makeTempDir, cleanupDir } from '../helpers/mocks.js';

describe('task view model (read-only)', () => {
  let artifactRoot: string;
  let store: TaskStore;

  beforeEach(async () => {
    artifactRoot = await makeTempDir();
    store = new TaskStore(artifactRoot);
  });

  afterEach(async () => {
    await cleanupDir(artifactRoot);
  });

  it('returns an empty list when there are no tasks', async () => {
    expect(await listTaskViews(artifactRoot)).toEqual([]);
  });

  it('lists tasks newest first (timestamp-prefixed ids)', async () => {
    await store.createTask({ id: '20260607-100000-older', title: 'older', repoRoot: '/r' });
    await store.createTask({ id: '20260607-120000-newer', title: 'newer', repoRoot: '/r' });
    const views = await listTaskViews(artifactRoot);
    expect(views.map((v) => v.title)).toEqual(['newer', 'older']);
  });

  it('includes lane, profile, team, and pending metadata', async () => {
    await store.createTask({
      id: '20260607-130000-task',
      title: 'with everything',
      repoRoot: '/r',
      lane: 'feature',
      laneSource: 'user-selected',
      profile: 'daily',
      team: { head: 'claude', developmentLead: 'claude' },
    });
    const task = await store.getTask('20260607-130000-task');
    task.pending = {
      kind: 'user_decision',
      question: 'Ship it?',
      createdAt: new Date().toISOString(),
      directive: {
        actor: 'head',
        action: 'ask_user',
        requiresUserInput: true,
        risk: 'low',
        reason: 'r',
        question: 'Ship it?',
        successCriteria: [],
        checksToRun: [],
      },
    };
    await store.saveTask(task);

    const view = await loadTaskView(artifactRoot, '20260607-130000-task');
    expect(view.lane).toBe('feature');
    expect(view.profile).toBe('daily');
    expect(view.team).toEqual({ head: 'claude', developmentLead: 'claude' });
    expect(view.pending).toEqual({ kind: 'user_decision', question: 'Ship it?' });
    expect(view.waitingOnUser).toBe(true);
  });

  it('loads recent events and survives malformed log lines', async () => {
    await store.createTask({ id: '20260607-140000-ev', title: 'events', repoRoot: '/r' });
    const logPath = join(store.taskDir('20260607-140000-ev'), 'agency-log.ndjson');
    const logger = new EventLogger(logPath);
    await logger.log({ actor: 'kairo', action: 'task_created', status: 'completed', message: 'created' });
    await appendText(logPath, 'this line is not json at all\n');
    await logger.log({ actor: 'head', action: 'plan_ready', status: 'completed', message: 'plan ready' });

    const view = await loadTaskView(artifactRoot, '140000-ev');
    expect(view.recentEvents.map((e) => e.action)).toEqual(['task_created', 'plan_ready']);
    expect(view.latestEvent?.action).toBe('plan_ready');
  });

  it('includes artifact paths only for files that exist', async () => {
    await store.createTask({ id: '20260607-150000-art', title: 'artifacts', repoRoot: '/r' });
    const taskDir = store.taskDir('20260607-150000-art');
    await writeText(join(taskDir, 'report.md'), '# report');
    await writeText(join(taskDir, 'master-plan.md'), 'plan');
    // no manager-notes.md, no transcript

    const view = await loadTaskView(artifactRoot, '150000-art');
    const labels = view.artifactPaths.map((a) => a.label);
    expect(labels).toContain('report');
    expect(labels).toContain('master plan');
    expect(labels).not.toContain('manager notes');
    expect(labels).not.toContain('dev transcript');
  });
});
