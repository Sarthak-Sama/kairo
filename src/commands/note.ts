import { join } from 'node:path';
import { loadConfig } from '../core/config.js';
import { TaskStore } from '../core/task-store.js';
import { EventLogger } from '../core/events.js';
import { appendText } from '../utils/fs.js';

/**
 * Leave a supervision note on a task. Notes are durable context for future
 * Codex/Claude prompts — they do NOT answer pending questions or approve
 * plans (that stays `kairo ask`), and they never consume the pending
 * checkpoint.
 */
export async function noteCommand(repoRoot: string, taskIdPartial: string, message: string): Promise<void> {
  if (!message.trim()) {
    console.error('[kairo] note must not be empty');
    process.exitCode = 1;
    return;
  }
  const config = await loadConfig(repoRoot);
  const store = new TaskStore(join(repoRoot, config.artifactDir));
  const taskId = await store.resolveTaskId(taskIdPartial);
  const task = await store.getTask(taskId); // validates the task exists/loads
  const taskDir = store.taskDir(taskId);

  await appendText(
    join(taskDir, 'manager-notes.md'),
    `## ${new Date().toISOString()}\n\n${message.trim()}\n\n`,
  );
  const events = new EventLogger(join(taskDir, 'agency-log.ndjson'));
  await events.log({ actor: 'user', action: 'note', status: 'completed', message: `manager note recorded: ${message.slice(0, 120)}` });

  console.log(`[kairo] note recorded for ${taskId}`);
  if (task.pending) {
    console.log(
      `[kairo] this task is still waiting on ${task.pending.kind === 'plan_approval' ? 'plan approval' : 'a decision'} — notes do not answer it; use: kairo ask ${taskId} "<answer>"`,
    );
  }
}
