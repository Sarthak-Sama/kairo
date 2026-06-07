import { join } from 'node:path';
import { loadConfig } from './config.js';
import { Orchestrator, type RunOutcome } from './orchestrator.js';
import { TaskStore } from './task-store.js';
import { EventLogger, type AgencyEvent } from './events.js';
import { ExecaProcessRunner } from '../adapters/process-runner.js';
import { createAgentTeam } from '../adapters/team.js';
import { appendText } from '../utils/fs.js';

/**
 * Shared user-action use-cases, consumed by both the CLI commands and the
 * TUI. Pure of console/exit-code concerns: callers render the structured
 * outcomes. All orchestration stays in the Orchestrator — nothing here
 * duplicates it.
 */

export interface ActionHooks {
  onEvent?: (event: AgencyEvent) => void;
}

export type AskActionResult =
  | { status: 'empty-message' }
  | { status: 'no-pending'; taskId: string; state: string }
  | { status: 'head-missing'; taskId: string; provider: string; command: string }
  | { status: 'refused'; taskId: string; error: string }
  | { status: 'done'; taskId: string; outcome: RunOutcome };

/**
 * Answer a paused task (approval word approves; anything else is feedback or
 * the answer). Identical semantics and audit honesty to `kairo ask`:
 * `handled: true` is recorded ONLY after the pending checkpoint is consumed.
 */
export async function askAction(
  repoRoot: string,
  taskIdPartial: string,
  message: string,
  hooks: ActionHooks = {},
): Promise<AskActionResult> {
  if (!message.trim()) return { status: 'empty-message' };
  const config = await loadConfig(repoRoot);
  const store = new TaskStore(join(repoRoot, config.artifactDir));
  const taskId = await store.resolveTaskId(taskIdPartial);
  const task = await store.getTask(taskId);

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
    return { status: 'no-pending', taskId, state: task.state };
  }

  const runner = new ExecaProcessRunner();
  // Continue with the team the task started with; profiles never change mid-task.
  const team = createAgentTeam(runner, config, repoRoot, task.team ?? undefined);

  if (!(await team.head.isAvailable())) {
    const command = config[team.head.provider].command;
    await recordMessage(false, `head agent "${team.head.provider}" ("${command}") not available`);
    return { status: 'head-missing', taskId, provider: team.head.provider, command };
  }

  const orchestrator = new Orchestrator({
    config,
    repoRoot,
    head: team.head,
    developmentLead: team.developmentLead,
    runner,
    // Non-interactive: any follow-up interaction pauses again with fresh
    // pending metadata, answerable by another ask.
    askUser: async () => null,
    approvePlan: async () => null,
    ...(hooks.onEvent ? { onEvent: hooks.onEvent } : {}),
  });

  let outcome: RunOutcome;
  try {
    outcome = await orchestrator.resume(taskId, message);
  } catch (err) {
    await recordMessage(false, `resume refused: ${(err as Error).message}`);
    return { status: 'refused', taskId, error: (err as Error).message };
  }
  await recordMessage(true);
  return { status: 'done', taskId, outcome };
}

export interface NoteActionResult {
  taskId: string;
  /** True when the task still has a pending checkpoint (notes never consume it). */
  stillPending: boolean;
  pendingKind: 'plan_approval' | 'user_decision' | null;
}

/** Record a supervision note. Never touches the pending checkpoint. */
export async function noteAction(repoRoot: string, taskIdPartial: string, message: string): Promise<NoteActionResult> {
  if (!message.trim()) throw new Error('note must not be empty');
  const config = await loadConfig(repoRoot);
  const store = new TaskStore(join(repoRoot, config.artifactDir));
  const taskId = await store.resolveTaskId(taskIdPartial);
  const task = await store.getTask(taskId);
  const taskDir = store.taskDir(taskId);

  await appendText(join(taskDir, 'manager-notes.md'), `## ${new Date().toISOString()}\n\n${message.trim()}\n\n`);
  const events = new EventLogger(join(taskDir, 'agency-log.ndjson'));
  await events.log({
    actor: 'user',
    action: 'note',
    status: 'completed',
    message: `manager note recorded: ${message.slice(0, 120)}`,
  });

  return { taskId, stillPending: task.pending !== null, pendingKind: task.pending?.kind ?? null };
}

/**
 * Stop a task: paused tasks finalize immediately; active tasks get the
 * control.json signal honored by transports at the next cancellation poll.
 * Throws on terminal tasks (same as `kairo stop`).
 */
export async function stopAction(
  repoRoot: string,
  taskIdPartial: string,
  reason: string,
  hooks: ActionHooks = {},
): Promise<RunOutcome> {
  const config = await loadConfig(repoRoot);
  const runner = new ExecaProcessRunner();
  const team = createAgentTeam(runner, config, repoRoot);
  const orchestrator = new Orchestrator({
    config,
    repoRoot,
    head: team.head, // never invoked by stop
    developmentLead: team.developmentLead, // never invoked by stop
    runner,
    askUser: async () => null,
    approvePlan: async () => null,
    ...(hooks.onEvent ? { onEvent: hooks.onEvent } : {}),
  });
  return orchestrator.stop(taskIdPartial, reason);
}
