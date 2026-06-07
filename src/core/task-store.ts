import { z } from 'zod';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { ensureDir, fileExists, readJson, writeJson } from '../utils/fs.js';
import { DirectiveSchema } from './directives.js';

export const TASK_STATES = [
  'created',
  'triaging',
  'awaiting_plan_approval',
  'planning_approved',
  'implementing',
  'checking',
  'reviewing',
  'awaiting_user_decision',
  'revising',
  'completed',
  'interrupted',
  'blocked',
  'failed',
  'reported',
] as const;

export const TaskStateSchema = z.enum(TASK_STATES);
export type TaskState = z.infer<typeof TaskStateSchema>;

const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  'completed',
  'blocked',
  'failed',
  'reported',
]);

/**
 * Canonical record of what a paused task is waiting for. task.json is the
 * source of truth for resume — the NDJSON log is audit trail only.
 */
export const PendingSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('plan_approval'),
      directive: DirectiveSchema,
      planPath: z.string(),
      createdAt: z.string(),
    }),
    z.object({
      kind: z.literal('user_decision'),
      directive: DirectiveSchema,
      question: z.string(),
      createdAt: z.string(),
    }),
  ])
  .nullable();

export type PendingState = z.infer<typeof PendingSchema>;

export const TaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  state: TaskStateSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  repoRoot: z.string(),
  baseline: z
    .object({
      isGitRepo: z.boolean(),
      headSha: z.string().nullable(),
      branch: z.string().nullable(),
      dirty: z.boolean().nullable(),
    })
    .nullable()
    .default(null),
  currentPhase: z.number().int().min(0).default(0),
  revisionCount: z.number().int().min(0).default(0),
  modelCalls: z.number().int().min(0).default(0),
  outcome: z.string().nullable().default(null),
  /** User-defined profile name used for this run; null = none (roles/default). */
  profile: z.string().nullable().default(null),
  /** Providers that filled the roles for this run; legacy tasks load null. */
  team: z
    .object({ head: z.enum(['codex', 'claude']), developmentLead: z.enum(['codex', 'claude']) })
    .nullable()
    .default(null),
  // Tasks created before resumability load with pending: null.
  pending: PendingSchema.default(null),
  stateHistory: z
    .array(
      z.object({
        state: TaskStateSchema,
        at: z.string(),
      }),
    )
    .default([]),
});

export type Task = z.infer<typeof TaskSchema>;

export function isTerminalState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * File-backed task store. Each task lives in `.kairo/tasks/<id>/` and its
 * canonical state is `task.json` — no database, no hidden state.
 */
export class TaskStore {
  constructor(
    private readonly artifactRoot: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  tasksDir(): string {
    return join(this.artifactRoot, 'tasks');
  }

  taskDir(taskId: string): string {
    return join(this.tasksDir(), taskId);
  }

  taskJsonPath(taskId: string): string {
    return join(this.taskDir(taskId), 'task.json');
  }

  phaseDir(taskId: string, phase: number): string {
    return join(this.taskDir(taskId), `phase-${String(phase).padStart(3, '0')}`);
  }

  async createTask(input: {
    id: string;
    title: string;
    repoRoot: string;
    profile?: string | null;
    team?: { head: 'codex' | 'claude'; developmentLead: 'codex' | 'claude' } | null;
  }): Promise<Task> {
    const now = this.clock().toISOString();
    const existing = await fileExists(this.taskJsonPath(input.id));
    if (existing) {
      throw new Error(`Task ${input.id} already exists`);
    }
    const task: Task = {
      id: input.id,
      title: input.title,
      state: 'created',
      createdAt: now,
      updatedAt: now,
      repoRoot: input.repoRoot,
      baseline: null,
      currentPhase: 0,
      revisionCount: 0,
      modelCalls: 0,
      outcome: null,
      profile: input.profile ?? null,
      team: input.team ?? null,
      pending: null,
      stateHistory: [{ state: 'created', at: now }],
    };
    await ensureDir(this.taskDir(input.id));
    await writeJson(this.taskJsonPath(input.id), task);
    return task;
  }

  async getTask(taskId: string): Promise<Task> {
    const path = this.taskJsonPath(taskId);
    if (!(await fileExists(path))) {
      throw new Error(`No task found with id ${taskId}`);
    }
    const raw = await readJson<unknown>(path);
    return TaskSchema.parse(raw);
  }

  async saveTask(task: Task): Promise<Task> {
    const updated: Task = { ...task, updatedAt: this.clock().toISOString() };
    await writeJson(this.taskJsonPath(task.id), updated);
    return updated;
  }

  async transition(taskId: string, state: TaskState): Promise<Task> {
    const task = await this.getTask(taskId);
    const now = this.clock().toISOString();
    const updated: Task = {
      ...task,
      state,
      updatedAt: now,
      stateHistory: [...task.stateHistory, { state, at: now }],
    };
    await writeJson(this.taskJsonPath(task.id), updated);
    return updated;
  }

  async listTasks(): Promise<Task[]> {
    const dir = this.tasksDir();
    if (!(await fileExists(dir))) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    const tasks: Task[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        tasks.push(await this.getTask(entry.name));
      } catch {
        // A folder without a readable task.json is corrupt; skip but do not crash listing.
      }
    }
    tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return tasks;
  }

  /** Resolve a possibly-partial task ID (unique prefix match). */
  async resolveTaskId(partial: string): Promise<string> {
    if (await fileExists(this.taskJsonPath(partial))) return partial;
    const dir = this.tasksDir();
    if (!(await fileExists(dir))) {
      throw new Error(`No tasks directory at ${dir}`);
    }
    const entries = await readdir(dir, { withFileTypes: true });
    const matches = entries
      .filter((e) => e.isDirectory() && e.name.includes(partial))
      .map((e) => e.name);
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) throw new Error(`No task matching "${partial}"`);
    throw new Error(`Ambiguous task id "${partial}" — matches: ${matches.join(', ')}`);
  }
}
