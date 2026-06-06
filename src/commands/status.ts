import { join } from 'node:path';
import { loadConfig } from '../core/config.js';
import { TaskStore } from '../core/task-store.js';

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
    const phase = task.currentPhase > 0 ? ` phase ${task.currentPhase}` : '';
    console.log(`  ${task.id}`);
    console.log(`    state: ${task.state}${phase}  outcome: ${task.outcome ?? '-'}`);
    console.log(`    title: ${task.title}`);
    console.log(`    updated: ${task.updatedAt}`);
    console.log('');
  }
}
