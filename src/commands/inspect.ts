import { join, relative } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { loadConfig } from '../core/config.js';
import { TaskStore } from '../core/task-store.js';

export async function inspectCommand(repoRoot: string, taskIdPartial: string): Promise<void> {
  const config = await loadConfig(repoRoot);
  const store = new TaskStore(join(repoRoot, config.artifactDir));
  const taskId = await store.resolveTaskId(taskIdPartial);
  const task = await store.getTask(taskId);
  const taskDir = store.taskDir(taskId);

  console.log(`[kairo] task ${task.id}`);
  console.log(`  title:       ${task.title}`);
  console.log(`  state:       ${task.state}`);
  console.log(`  outcome:     ${task.outcome ?? '-'}`);
  console.log(`  created:     ${task.createdAt}`);
  console.log(`  updated:     ${task.updatedAt}`);
  console.log(`  phase:       ${task.currentPhase}`);
  console.log(`  model calls: ${task.modelCalls}`);
  if (task.baseline) {
    console.log(
      `  baseline:    ${task.baseline.isGitRepo ? `${task.baseline.branch}@${task.baseline.headSha?.slice(0, 8)}${task.baseline.dirty ? ' (dirty)' : ''}` : 'not a git repo'}`,
    );
  }
  if (task.pending) {
    console.log('\n  pending:');
    console.log(`    kind:      ${task.pending.kind}`);
    if (task.pending.kind === 'plan_approval') {
      console.log(`    plan:      ${task.pending.planPath}`);
    } else {
      console.log(`    question:  ${task.pending.question}`);
    }
    console.log(`    directive: ${task.pending.directive.action} (risk ${task.pending.directive.risk})`);
    console.log(`    since:     ${task.pending.createdAt}`);
    console.log(`    continue:  kairo resume ${task.id}  |  kairo ask ${task.id} "<answer>"`);
  }
  console.log('\n  state history:');
  for (const entry of task.stateHistory) {
    console.log(`    ${entry.at}  ${entry.state}`);
  }

  console.log('\n  artifacts:');
  await printTree(taskDir, taskDir, '    ');
}

async function printTree(root: string, dir: string, indent: string): Promise<void> {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      console.log(`${indent}${relative(root, full)}/`);
      await printTree(root, full, indent);
    } else {
      const size = (await stat(full)).size;
      console.log(`${indent}${relative(root, full)} (${formatSize(size)})`);
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
