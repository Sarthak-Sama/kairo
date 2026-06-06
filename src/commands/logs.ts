import { join } from 'node:path';
import { loadConfig } from '../core/config.js';
import { TaskStore } from '../core/task-store.js';
import { readEventLog } from '../core/events.js';
import { formatEventLine } from '../renderers/timeline.js';

export async function logsCommand(repoRoot: string, taskIdPartial: string): Promise<void> {
  const config = await loadConfig(repoRoot);
  const store = new TaskStore(join(repoRoot, config.artifactDir));
  const taskId = await store.resolveTaskId(taskIdPartial);
  const logPath = join(store.taskDir(taskId), 'agency-log.ndjson');
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
