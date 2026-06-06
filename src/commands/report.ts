import { join } from 'node:path';
import { loadConfig } from '../core/config.js';
import { TaskStore } from '../core/task-store.js';
import { fileExists, readText } from '../utils/fs.js';

/** Print the task's final report; tell the user plainly if none exists yet. */
export async function reportCommand(repoRoot: string, taskIdPartial: string): Promise<void> {
  const config = await loadConfig(repoRoot);
  const store = new TaskStore(join(repoRoot, config.artifactDir));
  const taskId = await store.resolveTaskId(taskIdPartial);
  const reportPath = join(store.taskDir(taskId), 'report.md');
  if (!(await fileExists(reportPath))) {
    const task = await store.getTask(taskId);
    console.log(
      `[kairo] no report yet for ${taskId} (state: ${task.state}). Reports are generated when a run finishes.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(await readText(reportPath));
}
