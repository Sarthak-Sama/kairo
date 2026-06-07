import { noteAction } from '../core/actions.js';

/**
 * Leave a supervision note on a task. Notes are durable context for future
 * model calls — they do NOT answer pending questions or approve plans (that
 * stays `kairo ask`), and they never consume the pending checkpoint.
 */
export async function noteCommand(repoRoot: string, taskIdPartial: string, message: string): Promise<void> {
  if (!message.trim()) {
    console.error('[kairo] note must not be empty');
    process.exitCode = 1;
    return;
  }
  const result = await noteAction(repoRoot, taskIdPartial, message);
  console.log(`[kairo] note recorded for ${result.taskId}`);
  if (result.stillPending) {
    const what = result.pendingKind === 'plan_approval' ? 'plan approval' : 'a decision';
    console.log(
      `[kairo] this task is still waiting on ${what} — notes do not answer it; use: kairo ask ${result.taskId} "<answer>"`,
    );
  }
}
