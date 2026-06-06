import { join } from 'node:path';
import { loadConfig } from '../core/config.js';
import { Orchestrator } from '../core/orchestrator.js';
import { TaskStore } from '../core/task-store.js';
import { ExecaProcessRunner } from '../adapters/process-runner.js';
import { CodexCliAdapter } from '../adapters/codex.js';
import { createClaudeAdapter } from '../adapters/claude-factory.js';
import { TimelineRenderer } from '../renderers/timeline.js';
import { appendText } from '../utils/fs.js';
import { neverPrompt } from './interactive.js';

/**
 * Provide a user message to a paused task non-interactively.
 * Paused on plan approval: "y"/"yes"/"approve" approves, anything else is
 * plan feedback. Paused on a question: the message is the answer.
 * Not paused: the message is recorded as a note; nothing runs.
 */
export async function askCommand(repoRoot: string, taskIdPartial: string, message: string): Promise<void> {
  if (!message.trim()) {
    console.error('[kairo] message must not be empty');
    process.exitCode = 1;
    return;
  }
  // Intentional audit gap: failures BEFORE the task is identified (missing
  // config, unknown/ambiguous task id, unreadable task.json) record nothing —
  // there is no resolved task directory to write an honest audit line into.
  const config = await loadConfig(repoRoot);
  const store = new TaskStore(join(repoRoot, config.artifactDir));
  const taskId = await store.resolveTaskId(taskIdPartial);
  const task = await store.getTask(taskId);

  // Audit honesty: `handled: true` is written ONLY after the resume has
  // actually consumed the pending checkpoint. Every refusal path (no pending
  // decision, Codex missing, dirty-tree guard, any resume error) records
  // handled: false with the reason. Append-only.
  const recordMessage = async (handled: boolean, reason?: string): Promise<void> => {
    await appendText(
      join(store.taskDir(taskId), 'user-messages.ndjson'),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        message,
        handled,
        ...(reason ? { reason } : {}),
      }) + '\n',
    );
  };

  const paused = task.state === 'awaiting_plan_approval' || task.state === 'awaiting_user_decision';
  if (!paused) {
    await recordMessage(false, `no pending decision (task state: ${task.state})`);
    console.log(
      `[kairo] message recorded, but task ${taskId} has no pending decision to resume from (state: ${task.state}). Nothing was run.`,
    );
    return;
  }

  const runner = new ExecaProcessRunner();
  const codex = new CodexCliAdapter(runner, config, repoRoot);
  const claude = createClaudeAdapter(runner, config, repoRoot);
  const timeline = new TimelineRenderer();

  if (!(await codex.isAvailable())) {
    await recordMessage(false, `Codex CLI ("${config.codex.command}") not available`);
    console.error(
      `[kairo] Codex CLI ("${config.codex.command}") not found on PATH. Install it or set codex.command in .kairo/config.json. Message recorded as unhandled.`,
    );
    process.exitCode = 1;
    return;
  }

  const orchestrator = new Orchestrator({
    config,
    repoRoot,
    codex,
    claude,
    runner,
    // Non-interactive: any follow-up interaction pauses again with fresh
    // pending metadata, answerable by another `kairo ask`.
    askUser: neverPrompt.askUser,
    approvePlan: neverPrompt.approvePlan,
    onEvent: (event) => timeline.render(event),
  });

  let outcome;
  try {
    outcome = await orchestrator.resume(taskId, message);
  } catch (err) {
    // Resume refused before consuming the checkpoint (dirty tree, legacy
    // task, state changed underneath us, ...) — the message was NOT handled.
    await recordMessage(false, `resume refused: ${(err as Error).message}`);
    throw err;
  }
  // resume() returning means the pending checkpoint was consumed — even if
  // the continuation later failed, the message itself was applied.
  await recordMessage(true);

  if (outcome.reportPath) {
    timeline.info(`report saved: ${outcome.reportPath}`);
  }
  timeline.info(`task ${outcome.taskId} finished: ${outcome.outcome}`);
  if (['failed', 'blocked', 'unsafe'].includes(outcome.outcome)) {
    process.exitCode = 1;
  }
}
