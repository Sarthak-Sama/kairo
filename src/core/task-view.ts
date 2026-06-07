import { join } from 'node:path';
import { TaskStore, type Task } from './task-store.js';
import { readEventLog, type AgencyEvent } from './events.js';
import { fileExists } from '../utils/fs.js';

/**
 * Read-only, TUI-friendly snapshot of a task. Built entirely from the
 * existing artifact model (task.json + agency-log.ndjson + files on disk) —
 * no parallel state, no mutations.
 */
export interface TaskView {
  taskId: string;
  title: string;
  state: Task['state'];
  outcome: string | null;
  profile: string | null;
  team: { head: string; developmentLead: string } | null;
  pending:
    | { kind: 'plan_approval'; planPath: string }
    | { kind: 'user_decision'; question: string }
    | null;
  latestEvent: AgencyEvent | null;
  recentEvents: AgencyEvent[];
  artifactPaths: Array<{ label: string; path: string }>;
  updatedAt: string;
  waitingOnUser: boolean;
}

const RECENT_EVENT_COUNT = 12;

/** All tasks, newest first. Tolerates an empty/missing tasks directory. */
export async function listTaskViews(artifactRoot: string): Promise<TaskView[]> {
  const store = new TaskStore(artifactRoot);
  const tasks = await store.listTasks();
  const views = await Promise.all(tasks.map((task) => buildView(store, task)));
  return views.sort((a, b) => b.taskId.localeCompare(a.taskId)); // ids are timestamp-prefixed
}

export async function loadTaskView(artifactRoot: string, taskIdPartial: string): Promise<TaskView> {
  const store = new TaskStore(artifactRoot);
  const taskId = await store.resolveTaskId(taskIdPartial);
  return buildView(store, await store.getTask(taskId));
}

async function buildView(store: TaskStore, task: Task): Promise<TaskView> {
  const taskDir = store.taskDir(task.id);
  // Malformed lines are surfaced by readEventLog, never thrown — the view
  // simply shows the parseable events.
  const { events } = await readEventLog(join(taskDir, 'agency-log.ndjson'));

  const candidatePaths: Array<{ label: string; path: string }> = [
    { label: 'report', path: join(taskDir, 'report.md') },
    { label: 'master plan', path: join(taskDir, 'master-plan.md') },
    { label: 'user decisions', path: join(taskDir, 'user-decisions.md') },
    { label: 'manager notes', path: join(taskDir, 'manager-notes.md') },
    { label: 'dev transcript', path: join(store.phaseDir(task.id, Math.max(task.currentPhase, 1)), 'development-lead-transcript.log') },
    { label: 'event log', path: join(taskDir, 'agency-log.ndjson') },
  ];
  const artifactPaths: Array<{ label: string; path: string }> = [];
  for (const candidate of candidatePaths) {
    if (await fileExists(candidate.path)) artifactPaths.push(candidate);
  }

  return {
    taskId: task.id,
    title: task.title,
    state: task.state,
    outcome: task.outcome,
    profile: task.profile,
    team: task.team,
    pending:
      task.pending === null
        ? null
        : task.pending.kind === 'plan_approval'
          ? { kind: 'plan_approval', planPath: task.pending.planPath }
          : { kind: 'user_decision', question: task.pending.question },
    latestEvent: events[events.length - 1] ?? null,
    recentEvents: events.slice(-RECENT_EVENT_COUNT),
    artifactPaths,
    updatedAt: task.updatedAt,
    waitingOnUser: task.pending !== null,
  };
}
