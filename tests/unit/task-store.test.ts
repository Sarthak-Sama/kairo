import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskStore, isTerminalState } from '../../src/core/task-store.js';
import { makeTempDir, cleanupDir } from '../helpers/mocks.js';

describe('task store', () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(async () => {
    dir = await makeTempDir();
    store = new TaskStore(dir);
  });

  afterEach(async () => {
    await cleanupDir(dir);
  });

  it('creates a task in created state with history', async () => {
    const task = await store.createTask({ id: 't-1', title: 'Test task', repoRoot: '/tmp/repo' });
    expect(task.state).toBe('created');
    expect(task.stateHistory).toHaveLength(1);
    expect(task.stateHistory[0]?.state).toBe('created');
  });

  it('persists and reloads tasks', async () => {
    await store.createTask({ id: 't-1', title: 'Test task', repoRoot: '/tmp/repo' });
    const loaded = await store.getTask('t-1');
    expect(loaded.title).toBe('Test task');
  });

  it('rejects duplicate task ids', async () => {
    await store.createTask({ id: 't-1', title: 'a', repoRoot: '/r' });
    await expect(store.createTask({ id: 't-1', title: 'b', repoRoot: '/r' })).rejects.toThrow(
      /already exists/,
    );
  });

  it('transitions append to state history and persist', async () => {
    await store.createTask({ id: 't-1', title: 'a', repoRoot: '/r' });
    await store.transition('t-1', 'triaging');
    await store.transition('t-1', 'implementing');
    const task = await store.getTask('t-1');
    expect(task.state).toBe('implementing');
    expect(task.stateHistory.map((h) => h.state)).toEqual(['created', 'triaging', 'implementing']);
  });

  it('lists tasks sorted by creation time', async () => {
    await store.createTask({ id: 'b-task', title: 'b', repoRoot: '/r' });
    await store.createTask({ id: 'a-task', title: 'a', repoRoot: '/r' });
    const tasks = await store.listTasks();
    expect(tasks).toHaveLength(2);
  });

  it('lists nothing when no tasks dir exists', async () => {
    expect(await store.listTasks()).toEqual([]);
  });

  it('resolves partial task ids when unique', async () => {
    await store.createTask({ id: '20260606-120000-fix-modal', title: 'a', repoRoot: '/r' });
    expect(await store.resolveTaskId('fix-modal')).toBe('20260606-120000-fix-modal');
  });

  it('rejects ambiguous partial ids', async () => {
    await store.createTask({ id: '20260606-1-fix', title: 'a', repoRoot: '/r' });
    await store.createTask({ id: '20260606-2-fix', title: 'b', repoRoot: '/r' });
    await expect(store.resolveTaskId('fix')).rejects.toThrow(/Ambiguous/);
  });

  it('errors on unknown task id', async () => {
    await store.createTask({ id: 't-1', title: 'a', repoRoot: '/r' });
    await expect(store.getTask('nope')).rejects.toThrow(/No task found/);
  });

  it('knows terminal states', () => {
    expect(isTerminalState('completed')).toBe(true);
    expect(isTerminalState('failed')).toBe(true);
    expect(isTerminalState('implementing')).toBe(false);
  });
});
