import { join } from 'node:path';
import { loadConfig } from '../core/config.js';
import { TaskStore, type Task } from '../core/task-store.js';
import { readEventLog, type AgencyEvent } from '../core/events.js';
import { actorTag } from '../renderers/timeline.js';

/**
 * Compact agency overview: per task — state, phase, what happened last,
 * whether it is waiting on the user, and when. Answers "what is happening?"
 * and "what is waiting on me?" at a glance.
 */
export async function statusCommand(repoRoot: string): Promise<void> {
  const config = await loadConfig(repoRoot);
  const store = new TaskStore(join(repoRoot, config.artifactDir));
  const tasks = await store.listTasks();
  if (tasks.length === 0) {
    console.log('[kairo] no tasks yet. Start one with: kairo run "<task>"');
    return;
  }

  console.log(`[kairo] ${tasks.length} task(s):\n`);
  for (const task of tasks) {
    const { events } = await readEventLog(join(store.taskDir(task.id), 'agency-log.ndjson'));
    const last = events[events.length - 1];
    console.log(formatTaskLines(task, last));
  }

  const waiting = tasks.filter((t) => t.pending !== null);
  if (waiting.length > 0) {
    console.log('waiting on you:');
    for (const task of waiting) {
      const what = task.pending?.kind === 'plan_approval' ? 'plan approval' : 'a decision';
      console.log(`  ${task.id} needs ${what} — kairo resume ${task.id}  |  kairo ask ${task.id} "<answer>"`);
    }
  }
}

function formatTaskLines(task: Task, lastEvent: AgencyEvent | undefined): string {
  const waiting = task.pending !== null ? '  << WAITING ON YOU' : '';
  const phase = task.currentPhase > 0 ? `  phase ${task.currentPhase}` : '';
  const lastLine = lastEvent
    ? `${actorTag(lastEvent)} ${lastEvent.action} (${lastEvent.status}) — ${truncate(lastEvent.message, 90)}`
    : '(no events)';
  return [
    `  ${task.id}`,
    `    ${task.state}${phase}  outcome: ${task.outcome ?? '-'}${waiting}`,
    `    title:   ${truncate(task.title, 100)}`,
    `    last:    ${lastLine}`,
    `    updated: ${task.updatedAt}`,
    '',
  ].join('\n');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}
