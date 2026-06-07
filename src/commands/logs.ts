import { join } from 'node:path';
import { loadConfig } from '../core/config.js';
import { TaskStore, isTerminalState } from '../core/task-store.js';
import { readEventLog, followEventLog } from '../core/events.js';
import { formatEventLine } from '../renderers/timeline.js';

export async function logsCommand(
  repoRoot: string,
  taskIdPartial: string,
  options: { follow?: boolean } = {},
): Promise<void> {
  const config = await loadConfig(repoRoot);
  const store = new TaskStore(join(repoRoot, config.artifactDir));
  const taskId = await store.resolveTaskId(taskIdPartial);
  const logPath = join(store.taskDir(taskId), 'agency-log.ndjson');

  if (options.follow) {
    // Tail the audit log until the task stops moving: terminal states are
    // final; paused states wait on the user, so nothing more will be written
    // until a resume/ask happens (which is a fresh process anyway).
    console.log(`[kairo] following ${taskId} (stops when the task is terminal or waiting on you)\n`);
    await followEventLog(logPath, (event) => console.log('  ' + formatEventLine(event)), {
      pollIntervalMs: 500,
      isDone: async () => {
        const task = await store.getTask(taskId);
        return isTerminalState(task.state) || task.pending !== null;
      },
    });
    const task = await store.getTask(taskId);
    console.log(
      `\n[kairo] stopped following: task is ${task.state}${task.pending ? ` (waiting on you — kairo resume ${taskId})` : ''}`,
    );
    return;
  }

  const { events, malformedLines } = await readEventLog(logPath);
  if (events.length === 0) {
    console.log(`[kairo] no events logged for ${taskId}`);
    return;
  }
  console.log(`[kairo] agency log for ${taskId} (${events.length} events):\n`);
  for (const event of events) {
    console.log('  ' + formatEventLine(event));
  }
  if (malformedLines.length > 0) {
    console.log(`\n[kairo] warning: ${malformedLines.length} malformed line(s) in log: ${malformedLines.join(', ')}`);
  }
}
