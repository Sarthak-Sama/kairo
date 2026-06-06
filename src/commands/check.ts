import { join } from 'node:path';
import { loadConfig } from '../core/config.js';
import { TaskStore } from '../core/task-store.js';
import { runChecks } from '../core/checks.js';
import { ExecaProcessRunner } from '../adapters/process-runner.js';
import { writeJson, writeText } from '../utils/fs.js';

/**
 * Re-run the configured checks for a task's repo and record results into the
 * task's latest phase folder (or a checks-manual folder if no phase exists).
 */
export async function checkCommand(repoRoot: string, taskIdPartial: string): Promise<void> {
  const config = await loadConfig(repoRoot);
  const store = new TaskStore(join(repoRoot, config.artifactDir));
  const taskId = await store.resolveTaskId(taskIdPartial);
  const task = await store.getTask(taskId);

  const runner = new ExecaProcessRunner();
  console.log(`[kairo] running ${config.checks.length} configured check(s) for ${taskId}`);
  const result = await runChecks(config.checks, runner, { cwd: repoRoot });

  for (const r of result.results) {
    const suffix = r.detail ? ` — ${r.detail}` : '';
    console.log(`  [checks] ${r.name}: ${r.status}${suffix} (${r.durationMs}ms)`);
  }
  console.log(
    `[kairo] checks: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped${result.blocked ? `, ${result.blocked} blocked` : ''}`,
  );

  const phase = Math.max(task.currentPhase, 1);
  const phaseDir = store.phaseDir(taskId, phase);
  await writeJson(join(phaseDir, 'checks.json'), result.results);
  await writeText(join(phaseDir, 'checks.log'), result.log || '(no checks ran)\n');
  console.log(`[kairo] results saved to ${join(phaseDir, 'checks.json')}`);

  if (result.failed > 0 || result.blocked > 0) {
    process.exitCode = 1;
  }
}
