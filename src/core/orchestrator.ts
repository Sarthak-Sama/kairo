import { join } from 'node:path';
import type { KairoConfig } from './config.js';
import type { CodexAdapter } from '../adapters/codex.js';
import type { ClaudeAdapter } from '../adapters/claude.js';
import type { ProcessRunner } from '../adapters/process-runner.js';
import { TaskStore, type Task } from './task-store.js';
import { EventLogger, readEventLog } from './events.js';
import { scanRepo } from './repo-scanner.js';
import { captureBaseline, captureDiff } from './diff.js';
import { runChecks, type ChecksRun } from './checks.js';
import { buildClaudePrompt, buildReviewPrompt, buildSelfEditPrompt, buildTriagePrompt } from './prompts.js';
import { generateReport, reviewMentionsBlockers } from './report.js';
import type { Directive } from './directives.js';
import { createTaskId } from '../utils/ids.js';
import { appendText, fileExists, readText, writeJson, writeText } from '../utils/fs.js';

export interface OrchestratorDeps {
  config: KairoConfig;
  repoRoot: string;
  codex: CodexAdapter;
  claude: ClaudeAdapter;
  runner: ProcessRunner;
  /** Ask the user a question and return their answer; null means "no interactive channel". */
  askUser: (question: string) => Promise<string | null>;
  /**
   * Ask the user to approve the master plan before implementation.
   * Return "y"/"yes"/"approve" to proceed, any other non-empty string as plan
   * feedback for Codex, or null to pause (no interactive channel / no answer).
   */
  approvePlan: (planPath: string) => Promise<string | null>;
  onEvent?: (event: import('./events.js').AgencyEvent) => void;
  clock?: () => Date;
}

export interface RunOutcome {
  taskId: string;
  finalState: Task['state'];
  outcome: string;
  reportPath: string | null;
}

interface PhaseRecord {
  phase: number;
  claudeReport: string;
  checksRun: ChecksRun | null;
  changedFiles: string[];
  review: string;
  /** Risk level Codex declared on the directive that drove this phase. */
  directiveRisk: 'low' | 'medium' | 'high';
  /** Risk level Codex declared on its review directive (null until reviewed). */
  reviewRisk: 'low' | 'medium' | 'high' | null;
  diffAvailable: boolean;
  diffNote?: string;
}

/**
 * Decide whether a directive needs explicit user plan approval before any
 * implementation. Only quick, low-risk self-edits skip the gate.
 */
export function requiresPlanApproval(directive: Directive): boolean {
  if (['ask_user', 'stop_blocked', 'stop_unsafe', 'declare_complete'].includes(directive.action)) {
    return false;
  }
  if (directive.risk === 'high') return true;
  if (directive.taskClass && /single_phase|multi_phase|claude|feature/i.test(directive.taskClass)) {
    return true;
  }
  if (['delegate_to_claude', 'request_claude_revision', 'continue_next_phase'].includes(directive.action)) {
    return true;
  }
  if (directive.action === 'self_edit') {
    // Bypass only when Codex itself classified the work as quick/trivial.
    return !(directive.taskClass && /quick|trivial/i.test(directive.taskClass));
  }
  return true;
}

/**
 * The agency loop:
 *   triage (codex) -> implement (claude or codex self-edit) -> diff -> checks
 *   -> review (codex) -> revise | next phase | complete | ask user | stop
 *
 * Every transition is persisted to task.json and the NDJSON event log before
 * the next step runs, so an interrupted run leaves a coherent trail.
 */
export class Orchestrator {
  private readonly store: TaskStore;
  private readonly clock: () => Date;
  private modelCalls = 0;
  private startedAt = 0;

  constructor(private readonly deps: OrchestratorDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.store = new TaskStore(join(deps.repoRoot, deps.config.artifactDir), this.clock);
  }

  async run(taskTitle: string): Promise<RunOutcome> {
    this.startedAt = Date.now();
    const taskId = createTaskId(taskTitle, this.clock());
    const task = await this.store.createTask({
      id: taskId,
      title: taskTitle,
      repoRoot: this.deps.repoRoot,
    });
    const taskDir = this.store.taskDir(taskId);
    const events = new EventLogger(join(taskDir, 'agency-log.ndjson'), this.clock);
    if (this.deps.onEvent) events.onEvent(this.deps.onEvent);

    await events.log({
      actor: 'kairo',
      action: 'task_created',
      status: 'completed',
      message: `task created: ${taskId}`,
    });

    try {
      return await this.runInner(task, taskDir, events);
    } catch (err) {
      await this.store.transition(taskId, 'failed');
      await this.setOutcome(taskId, 'failed');
      await events.log({
        actor: 'kairo',
        action: 'run_crashed',
        status: 'failed',
        message: `run failed: ${(err as Error).message}`,
        metadata: { stack: (err as Error).stack },
      });
      const reportPath = await this.writeReport(taskId, taskDir, [], `Run crashed: ${(err as Error).message}`);
      return { taskId, finalState: 'failed', outcome: 'failed', reportPath };
    }
  }

  private async runInner(task: Task, taskDir: string, events: EventLogger): Promise<RunOutcome> {
    const { config, repoRoot } = this.deps;
    const taskId = task.id;

    // Preflight: Kairo requires git diff accountability before any model can
    // touch the repo. Both gates stop the run before repo scan or model calls.
    const baseline = await captureBaseline(this.deps.runner, repoRoot);
    task.baseline = baseline;
    await this.store.saveTask(task);
    if (!baseline.isGitRepo) {
      await events.log({
        actor: 'kairo',
        action: 'preflight',
        status: 'failed',
        message:
          'not a git repository — Kairo requires git so every change can be attributed to the task via diffs. Run `git init` (and commit a baseline) first.',
      });
      return this.finishBlocked(
        taskId,
        taskDir,
        events,
        [],
        'this directory is not a git repository. Kairo requires git for diff accountability — run `git init` and commit a baseline before using `kairo run`',
        ['high: run attempted in a non-git repository; no implementation was performed'],
      );
    }
    if (baseline.dirty === true) {
      await events.log({
        actor: 'kairo',
        action: 'preflight',
        status: 'failed',
        message:
          'working tree has uncommitted changes — commit or stash them first so phase diffs belong only to this task. Kairo will not stash, clean, or commit for you.',
      });
      return this.finishBlocked(
        taskId,
        taskDir,
        events,
        [],
        'the working tree has uncommitted changes. Commit or stash them first so that every diff Kairo captures belongs to this task. Kairo never stashes, cleans, or commits on your behalf',
        ['high: run attempted on a dirty working tree; no implementation was performed'],
      );
    }
    await events.log({
      actor: 'kairo',
      action: 'baseline',
      status: 'completed',
      message: `baseline recorded: clean working tree at ${baseline.branch}@${baseline.headSha?.slice(0, 8)}`,
    });

    await this.store.transition(taskId, 'triaging');
    await events.log({ actor: 'codex', action: 'inspect_repo', status: 'started', message: 'inspecting repo' });
    const scan = await scanRepo(repoRoot, config);
    await writeText(join(taskDir, 'repo-scan.md'), scan.markdown);

    // Codex triage
    if (!(await this.checkLimits(taskId, events))) {
      return this.finishBlocked(taskId, taskDir, events, [], 'limits reached before triage');
    }
    const triage = await this.deps.codex.invokeForDirective({
      purpose: 'triage',
      sandbox: 'read-only', // planning never gets write access
      prompt: buildTriagePrompt({ taskTitle: task.title, repoScanMarkdown: scan.markdown, config }),
    });
    this.modelCalls++;
    await writeText(join(taskDir, 'codex-session.json'), JSON.stringify({
      invocations: [{ purpose: 'triage', exitCode: triage.result.exitCode, durationMs: triage.result.durationMs }],
    }, null, 2));

    if (!triage.parsed.ok || !triage.parsed.directive) {
      await writeText(join(taskDir, 'codex-triage-raw.txt'), triage.parsed.rawOutput || triage.result.rawStdout);
      await events.log({
        actor: 'codex',
        action: 'triage',
        status: 'failed',
        message: `Codex did not return a valid directive: ${triage.parsed.error ?? 'unknown'}. Raw output saved to ${join(taskDir, 'codex-triage-raw.txt')} — inspect the task folder.`,
      });
      return this.finishFailed(taskId, taskDir, events, [], 'Codex triage produced an invalid directive');
    }

    // Master plan = the prose Codex wrote before the directive JSON.
    let masterPlan = extractProse(triage.result.lastMessage);
    await writeText(join(taskDir, 'master-plan.md'), masterPlan || '(Codex provided no plan prose)');
    let directive = triage.parsed.directive;
    await events.log({
      actor: 'codex',
      action: 'classify_task',
      status: 'completed',
      message: `classified task: ${directive.taskClass ?? directive.action}`,
      metadata: { action: directive.action, risk: directive.risk },
    });
    await events.log({ actor: 'codex', action: 'plan_ready', status: 'completed', message: 'plan ready' });

    const phases: PhaseRecord[] = [];
    let phase = 1;
    let revisionCount = 0;
    // The plan approval gate applies to the first implementation-bearing
    // directive of the run; once approved (or bypassed for quick low-risk
    // self-edits) later review-loop directives do not re-prompt.
    let planApproved = false;
    // Backstop iteration guard: the limits below (phases, revisions, model
    // calls) should always bound the loop first; this catches directive cycles
    // that would otherwise evade all of them.
    const maxIterations =
      this.deps.config.limits.maxPhases * (this.deps.config.limits.maxRevisionLoopsPerPhase + 2) + 10;
    let iterations = 0;

    // Main agency loop. Each iteration acts on the current directive.
    for (;;) {
      if (++iterations > maxIterations) {
        return this.finishBlocked(taskId, taskDir, events, phases, `loop iteration guard tripped (${maxIterations} iterations)`);
      }
      if (!(await this.checkLimits(taskId, events))) {
        return this.finishBlocked(taskId, taskDir, events, phases, 'run limits reached');
      }

      switch (directive.action) {
        case 'ask_user': {
          const answer = await this.handleAskUser(taskId, taskDir, events, directive);
          if (answer === null) {
            return this.finishState(taskId, taskDir, events, phases, 'awaiting_user_decision', 'awaiting user decision (no interactive channel)');
          }
          // Feed the answer back to Codex for a fresh directive.
          directive = await this.reinvokeCodexAfterUser(taskId, taskDir, events, task, masterPlan, directive, answer, phases);
          continue;
        }

        case 'self_edit':
        case 'delegate_to_claude':
        case 'request_claude_revision': {
          if (!planApproved) {
            const gate = await this.runPlanApprovalGate(taskId, taskDir, events, task, masterPlan, directive, phases);
            if ('outcome' in gate) return gate;
            if (gate.revisedDirective) {
              directive = gate.revisedDirective;
              if (gate.revisedPlan) {
                masterPlan = gate.revisedPlan;
                await writeText(join(taskDir, 'master-plan.md'), masterPlan);
              }
              continue;
            }
            planApproved = true;
          }
          const isRevision = directive.action === 'request_claude_revision';
          if (isRevision) {
            revisionCount++;
            if (revisionCount > this.deps.config.limits.maxRevisionLoopsPerPhase) {
              return this.finishBlocked(taskId, taskDir, events, phases, `revision limit (${this.deps.config.limits.maxRevisionLoopsPerPhase}) reached on phase ${phase}`);
            }
            await this.store.transition(taskId, 'revising');
          } else {
            await this.store.transition(taskId, 'implementing');
          }

          const phaseDir = this.store.phaseDir(taskId, phase);
          await writeJson(join(phaseDir, 'codex-directive.json'), directive);

          const implemented = await this.executeImplementation(taskId, taskDir, phaseDir, events, task, masterPlan, directive, phase, isRevision, phases);
          if ('error' in implemented) {
            return this.finishFailed(taskId, taskDir, events, phases, implemented.error);
          }
          const record = implemented.record;

          // Review the implementation.
          const phasesWithRecord = phases.filter((p) => p.phase !== phase).concat(record);
          const reviewed = await this.invokeReview(taskId, taskDir, events, task, masterPlan, phase, phaseDir, record, revisionCount, phasesWithRecord);
          if ('outcome' in reviewed) return reviewed;

          const existing = phases.findIndex((p) => p.phase === phase);
          if (existing >= 0) phases[existing] = record;
          else phases.push(record);

          directive = reviewed.directive;
          continue;
        }

        case 'continue_next_phase': {
          // The continue directive must carry instructions for the next phase;
          // without them we would delegate with stale instructions from a
          // previous directive — refuse instead.
          if (!directive.instructions) {
            return this.finishBlocked(taskId, taskDir, events, phases, `continue_next_phase directive for phase ${phase + 1} carried no instructions`);
          }
          phase++;
          revisionCount = 0;
          if (phase > this.deps.config.limits.maxPhases) {
            return this.finishBlocked(taskId, taskDir, events, phases, `phase limit (${this.deps.config.limits.maxPhases}) reached`);
          }
          const updated = await this.store.getTask(taskId);
          updated.currentPhase = phase;
          await this.store.saveTask(updated);
          directive = { ...directive, action: 'delegate_to_claude', phase };
          await events.log({ actor: 'codex', action: 'next_phase', status: 'started', message: `starting phase ${phase}` });
          continue;
        }

        case 'run_checks':
        case 'review_diff': {
          // Mid-loop utility: re-run checks for the current phase, then route
          // the results back through Codex review for a real decision. Kairo
          // never declares completion on Codex's behalf.
          const record = phases.find((p) => p.phase === phase);
          if (!record) {
            return this.finishBlocked(taskId, taskDir, events, phases, `${directive.action} directive received before any implementation phase`);
          }
          const phaseDir = this.store.phaseDir(taskId, phase);
          record.checksRun = await this.runPhaseChecks(taskId, phaseDir, events, directive.checksToRun);
          const reviewed = await this.invokeReview(taskId, taskDir, events, task, masterPlan, phase, phaseDir, record, revisionCount, phases);
          if ('outcome' in reviewed) return reviewed;
          directive = reviewed.directive;
          continue;
        }

        case 'declare_complete': {
          await events.log({ actor: 'codex', action: 'declare_complete', status: 'completed', message: 'task complete' });
          await this.store.transition(taskId, 'completed');
          await this.setOutcome(taskId, 'completed');
          const reportPath = await this.writeReport(taskId, taskDir, phases, directive.reason);
          await this.store.transition(taskId, 'reported');
          await events.log({ actor: 'kairo', action: 'report', status: 'completed', message: `report saved: ${reportPath}` });
          return { taskId, finalState: 'reported', outcome: 'completed', reportPath };
        }

        case 'stop_blocked':
          return this.finishBlocked(taskId, taskDir, events, phases, directive.reason);

        case 'stop_unsafe': {
          await events.log({ actor: 'codex', action: 'stop_unsafe', status: 'completed', message: `stopped as unsafe: ${directive.reason}` });
          await this.store.transition(taskId, 'blocked');
          await this.setOutcome(taskId, 'unsafe');
          const reportPath = await this.writeReport(taskId, taskDir, phases, `Stopped as unsafe: ${directive.reason}`);
          return { taskId, finalState: 'blocked', outcome: 'unsafe', reportPath };
        }
      }
    }
  }

  /**
   * Plan approval gate. Returns:
   * - `{}` when implementation may proceed (gate not required or approved),
   * - `{ revisedDirective }` when the user gave feedback and Codex produced a
   *   revised directive that must go back through the loop (and the gate),
   * - a RunOutcome when the run pauses (`awaiting_plan_approval`) or stops.
   */
  private async runPlanApprovalGate(
    taskId: string,
    taskDir: string,
    events: EventLogger,
    task: Task,
    masterPlan: string,
    directive: Directive,
    phases: PhaseRecord[],
  ): Promise<{ revisedDirective?: Directive; revisedPlan?: string } | RunOutcome> {
    if (!requiresPlanApproval(directive)) {
      await events.log({
        actor: 'kairo',
        action: 'plan_approval',
        status: 'skipped',
        message: `plan approval not required (${directive.action}, risk ${directive.risk}, class ${directive.taskClass ?? 'unspecified'})`,
      });
      return {};
    }

    const planPath = join(taskDir, 'master-plan.md');
    await this.store.transition(taskId, 'awaiting_plan_approval');
    await events.log({
      actor: 'kairo',
      action: 'plan_approval',
      status: 'started',
      message: `plan requires approval before implementation (${directive.action}, risk ${directive.risk}): ${planPath}`,
    });

    const answer = await this.deps.approvePlan(planPath);
    const stamp = this.clock().toISOString();

    if (answer === null) {
      await appendText(
        join(taskDir, 'user-decisions.md'),
        `## ${stamp}\n\n**Plan approval requested** for action \`${directive.action}\` — no answer (non-interactive or empty response). Run paused.\n\n`,
      );
      return this.finishState(
        taskId,
        taskDir,
        events,
        phases,
        'awaiting_plan_approval',
        `awaiting plan approval — review ${planPath} and re-run with your decision`,
      );
    }

    if (/^(y|yes|approve)$/i.test(answer.trim())) {
      await appendText(
        join(taskDir, 'user-decisions.md'),
        `## ${stamp}\n\n**Plan approval requested** for action \`${directive.action}\`.\n\n**A (user):** approved\n\n`,
      );
      await this.store.transition(taskId, 'planning_approved');
      await events.log({ actor: 'user', action: 'plan_approval', status: 'completed', message: 'plan approved by user' });
      return {};
    }

    // Anything else is plan feedback: send it back to Codex for a revised directive.
    await appendText(
      join(taskDir, 'user-decisions.md'),
      `## ${stamp}\n\n**Plan approval requested** for action \`${directive.action}\`.\n\n**Feedback (user):** ${answer}\n\n`,
    );
    await events.log({ actor: 'user', action: 'plan_feedback', status: 'completed', message: 'user sent plan feedback to codex' });
    if (!(await this.checkLimits(taskId, events))) {
      return this.finishBlocked(taskId, taskDir, events, phases, 'limits reached while revising plan');
    }
    this.modelCalls++;
    const revised = await this.deps.codex.invokeForDirective({
      purpose: 'plan-feedback',
      sandbox: 'read-only', // still planning — no write access
      prompt: `You are the agency head for Kairo. The user reviewed your plan for the task below and sent feedback instead of approving it. Revise your plan/directive accordingly.

## Task
${task.title}

## Your current plan
${masterPlan}

## User feedback on the plan
${answer}

Reply with your revised reasoning and end with one directive JSON object in a \`\`\`json fence (same schema as before).`,
    });
    if (!revised.parsed.ok || !revised.parsed.directive) {
      await writeText(join(taskDir, 'codex-plan-feedback-raw.txt'), revised.parsed.rawOutput);
      await events.log({
        actor: 'codex',
        action: 'plan_feedback',
        status: 'failed',
        message: 'Codex returned an invalid directive after plan feedback; raw output saved — inspect the task folder.',
      });
      return this.finishFailed(taskId, taskDir, events, phases, 'Codex produced an invalid directive after plan feedback');
    }
    await events.log({
      actor: 'codex',
      action: 'plan_revised',
      status: 'completed',
      message: `plan revised after feedback: next action ${revised.parsed.directive.action}`,
    });
    const revisedPlan = extractProse(revised.result.lastMessage);
    return {
      revisedDirective: revised.parsed.directive,
      ...(revisedPlan ? { revisedPlan } : {}),
    };
  }

  /**
   * Have Codex review the phase record and return its next directive.
   * Returns a RunOutcome instead when the run must terminate (limits hit or
   * the review directive was invalid).
   */
  private async invokeReview(
    taskId: string,
    taskDir: string,
    events: EventLogger,
    task: Task,
    masterPlan: string,
    phase: number,
    phaseDir: string,
    record: PhaseRecord,
    revisionCount: number,
    phasesForReport: PhaseRecord[],
  ): Promise<{ directive: Directive } | RunOutcome> {
    await this.store.transition(taskId, 'reviewing');
    if (!(await this.checkLimits(taskId, events))) {
      return this.finishBlocked(taskId, taskDir, events, phasesForReport, 'limits reached before review');
    }
    await events.log({ actor: 'codex', action: 'review', status: 'started', message: 'reviewing implementation' });
    const review = await this.deps.codex.invokeForDirective({
      purpose: `review-phase-${phase}`,
      sandbox: 'read-only', // reviewing never gets write access
      prompt: buildReviewPrompt({
        taskTitle: task.title,
        phase,
        masterPlan,
        claudeReport: record.claudeReport,
        diffPatch: await this.readPhaseDiff(phaseDir),
        checksRun: record.checksRun,
        revisionCount,
        maxRevisions: this.deps.config.limits.maxRevisionLoopsPerPhase,
        configuredCheckNames: this.deps.config.checks.map((c) => c.name),
      }),
    });
    this.modelCalls++;

    if (!review.parsed.ok || !review.parsed.directive) {
      await writeText(join(phaseDir, 'codex-review-raw.txt'), review.parsed.rawOutput || review.result.rawStdout);
      await events.log({
        actor: 'codex',
        action: 'review',
        status: 'failed',
        message: `Codex review returned an invalid directive: ${review.parsed.error ?? 'unknown'}. Raw output saved — inspect the task folder.`,
      });
      return this.finishFailed(taskId, taskDir, events, phasesForReport, 'Codex review produced an invalid directive');
    }

    record.review = extractProse(review.result.lastMessage);
    record.reviewRisk = review.parsed.directive.risk;
    await writeText(join(phaseDir, 'codex-review.md'), record.review || '(no review prose)');
    await writeJson(join(phaseDir, 'codex-decision.json'), review.parsed.directive);
    await events.log({
      actor: 'codex',
      action: 'review',
      status: 'completed',
      message: `review decision: ${review.parsed.directive.action}`,
      metadata: { risk: review.parsed.directive.risk },
    });
    return { directive: review.parsed.directive };
  }

  /**
   * Implement one phase. Self-edit runs a dedicated write-enabled Codex
   * invocation (triage was read-only); the Claude path invokes the adapter.
   */
  private async executeImplementation(
    taskId: string,
    taskDir: string,
    phaseDir: string,
    events: EventLogger,
    task: Task,
    masterPlan: string,
    directive: Directive,
    phase: number,
    isRevision: boolean,
    phases: PhaseRecord[],
  ): Promise<{ record: PhaseRecord } | { error: string }> {
    let claudeReport = '';

    if (directive.action === 'self_edit') {
      // Triage is read-only, so the edits have NOT happened yet: run a
      // separate write-enabled Codex invocation with the directive's
      // instructions.
      if (!directive.instructions) {
        await events.log({
          actor: 'kairo',
          action: 'self_edit',
          status: 'failed',
          message: 'self_edit directive carried no instructions — cannot run the self-edit session',
        });
        return { error: 'self_edit directive carried no instructions' };
      }
      const selfEditPrompt = buildSelfEditPrompt({
        taskTitle: task.title,
        phase,
        instructions: directive.instructions,
        masterPlan,
      });
      await writeText(join(phaseDir, 'codex-self-edit-prompt.md'), selfEditPrompt);
      await events.log({
        actor: 'codex',
        action: 'self_edit',
        status: 'started',
        message: `codex self-editing phase ${phase}: ${directive.reason}`,
      });
      const result = await this.deps.codex.invoke({
        purpose: `self-edit-phase-${phase}`,
        sandbox: this.deps.config.codex.sandbox, // write-enabled, unlike planning calls
        prompt: selfEditPrompt,
      });
      this.modelCalls++;
      await writeText(
        join(phaseDir, 'codex-self-edit-transcript.md'),
        result.lastMessage || result.rawStdout || '(no output)',
      );
      if (!result.ok) {
        await events.log({
          actor: 'codex',
          action: 'self_edit',
          status: 'failed',
          message: `codex self-edit invocation failed: ${result.error ?? 'unknown error'}`,
        });
        return { error: `Codex self-edit invocation failed: ${result.error ?? 'unknown error'}` };
      }
      await events.log({
        actor: 'codex',
        action: 'self_edit',
        status: 'completed',
        message: `codex self-edit session finished for phase ${phase}`,
      });
      claudeReport = `(Codex self-edit — no Claude involvement)\n\n${result.lastMessage}`;
    } else {
      if (!directive.instructions) {
        await events.log({
          actor: 'kairo',
          action: 'delegate',
          status: 'failed',
          message: 'directive had no instructions for Claude — cannot delegate',
        });
        return { error: 'directive had no instructions for Claude' };
      }
      // Claude is only required once work is actually delegated to it; check
      // availability here rather than blocking runs that never need Claude.
      if (!(await this.deps.claude.isAvailable())) {
        await events.log({
          actor: 'kairo',
          action: 'delegate',
          status: 'failed',
          message: `Claude CLI ("${this.deps.config.claude.command}") not found — Claude is required for delegated implementation. Install it or set claude.command in the Kairo config.`,
        });
        return {
          error: `Claude CLI ("${this.deps.config.claude.command}") is not available — Claude is required for delegated implementation`,
        };
      }
      const previous = phases.find((p) => p.phase === phase);
      const prompt = buildClaudePrompt({
        taskTitle: task.title,
        phase,
        instructions: directive.instructions,
        successCriteria: directive.successCriteria,
        masterPlan,
        isRevision,
        ...(previous?.claudeReport ? { previousReport: previous.claudeReport } : {}),
      });
      await writeText(join(phaseDir, 'claude-prompt.md'), prompt);
      await events.log({
        actor: 'claude',
        action: isRevision ? 'revise' : 'implement',
        status: 'started',
        message: isRevision ? `revising phase ${phase}` : `implementing phase ${phase}`,
      });

      // NOTE: the current Claude adapter buffers output and delivers it once
      // at process exit (see docs/limitations.md); the transcript is written
      // after the invocation, not streamed. The onChunk hook exists for the
      // future PTY adapter.
      const transcriptPath = join(phaseDir, 'claude-transcript.log');
      const result = await this.deps.claude.invoke({
        purpose: `phase-${phase}${isRevision ? '-revision' : ''}`,
        prompt,
      });
      this.modelCalls++;
      await writeText(transcriptPath, result.transcript || '(empty transcript)');
      await writeText(join(taskDir, 'claude-session.json'), JSON.stringify({
        lastInvocation: { purpose: `phase-${phase}`, exitCode: result.exitCode, durationMs: result.durationMs },
      }, null, 2));

      if (!result.ok) {
        await events.log({
          actor: 'claude',
          action: isRevision ? 'revise' : 'implement',
          status: 'failed',
          message: `Claude invocation failed: ${result.error ?? 'unknown error'}`,
        });
        return { error: `Claude invocation failed: ${result.error ?? 'unknown error'}` };
      }
      claudeReport = extractClaudeReport(result.transcript);
      await writeText(join(phaseDir, 'claude-report.md'), claudeReport);
      await events.log({
        actor: 'claude',
        action: isRevision ? 'revise' : 'implement',
        status: 'completed',
        message: `phase ${phase} ${isRevision ? 'revision' : 'implementation'} reported`,
      });
    }

    // Capture diff
    await events.log({ actor: 'kairo', action: 'capture_diff', status: 'started', message: 'capturing diff' });
    const diff = await captureDiff(this.deps.runner, this.deps.repoRoot);
    await writeText(join(phaseDir, 'diff.patch'), diff.patch || `# ${diff.note ?? 'no changes detected'}\n`);
    await events.log({
      actor: 'kairo',
      action: 'capture_diff',
      status: diff.available ? 'completed' : 'skipped',
      message: diff.available
        ? `diff captured (${diff.changedFiles.length} changed files)`
        : (diff.note ?? 'diff unavailable'),
    });

    // A self-edit that changed nothing means no work actually happened —
    // fail the run instead of letting an empty phase sail through review.
    if (directive.action === 'self_edit' && diff.available && diff.changedFiles.length === 0) {
      await events.log({
        actor: 'kairo',
        action: 'self_edit_verification',
        status: 'failed',
        message: 'codex self-edit session produced no working-tree changes',
      });
      return { error: 'Codex self-edit session produced no working-tree changes' };
    }

    // Run checks
    await this.store.transition(taskId, 'checking');
    const checksRun = await this.runPhaseChecks(taskId, phaseDir, events, directive.checksToRun);

    return {
      record: {
        phase,
        claudeReport,
        checksRun,
        changedFiles: diff.changedFiles,
        review: '',
        directiveRisk: directive.risk,
        reviewRisk: null,
        diffAvailable: diff.available,
        ...(diff.note !== undefined ? { diffNote: diff.note } : {}),
      },
    };
  }

  private async runPhaseChecks(
    _taskId: string,
    phaseDir: string,
    events: EventLogger,
    only: string[],
  ): Promise<ChecksRun> {
    await events.log({ actor: 'checks', action: 'run_checks', status: 'started', message: 'running checks' });
    const checksRun = await runChecks(this.deps.config.checks, this.deps.runner, {
      cwd: this.deps.repoRoot,
      ...(only.length > 0 ? { only } : {}),
    });
    await writeJson(join(phaseDir, 'checks.json'), checksRun.results);
    await writeText(join(phaseDir, 'checks.log'), checksRun.log || '(no checks ran)\n');
    if (checksRun.unknownOnlyNames.length > 0) {
      await events.log({
        actor: 'checks',
        action: 'run_checks',
        status: 'skipped',
        message: `directive named unknown check(s) ${checksRun.unknownOnlyNames.join(', ')} — ran the configured checks instead`,
      });
    }
    await events.log({
      actor: 'checks',
      action: 'run_checks',
      status: checksRun.failed > 0 ? 'failed' : 'completed',
      message: `checks: ${checksRun.passed} passed, ${checksRun.failed} failed, ${checksRun.skipped} skipped${checksRun.blocked ? `, ${checksRun.blocked} blocked` : ''}`,
    });
    return checksRun;
  }

  private async handleAskUser(
    taskId: string,
    taskDir: string,
    events: EventLogger,
    directive: Directive,
  ): Promise<string | null> {
    const question = directive.question ?? directive.reason;
    await this.store.transition(taskId, 'awaiting_user_decision');
    await events.log({ actor: 'codex', action: 'ask_user', status: 'started', message: `needs user decision: ${question}` });
    const answer = await this.deps.askUser(question);
    const decisionLine = `## ${this.clock().toISOString()}\n\n**Q (codex):** ${question}\n\n**A (user):** ${answer ?? '(no answer — run was non-interactive)'}\n\n`;
    await appendText(join(taskDir, 'user-decisions.md'), decisionLine);
    if (answer !== null) {
      await events.log({ actor: 'user', action: 'decision', status: 'completed', message: 'user answered' });
    }
    return answer;
  }

  private async reinvokeCodexAfterUser(
    taskId: string,
    taskDir: string,
    events: EventLogger,
    task: Task,
    masterPlan: string,
    directive: Directive,
    answer: string,
    phases: PhaseRecord[],
  ): Promise<Directive> {
    this.modelCalls++;
    const phaseContext =
      phases.length === 0
        ? '(no implementation phases have run yet)'
        : phases
            .map((p) => {
              const checks = p.checksRun
                ? p.checksRun.results.map((r) => `${r.name}=${r.status}`).join(', ')
                : 'checks not run';
              return `### Phase ${p.phase}\nChecks: ${checks}\nChanged files: ${p.changedFiles.join(', ') || '(none)'}\nReview: ${p.review || '(pending)'}\nImplementer report:\n${p.claudeReport.slice(0, 2000)}`;
            })
            .join('\n\n');
    const followup = await this.deps.codex.invokeForDirective({
      purpose: 'after-user-decision',
      sandbox: 'read-only', // deciding, not editing
      prompt: `You previously asked the user a question while working on the task below.

## Task
${task.title}

## Master plan
${masterPlan}

## Work completed so far
${phaseContext}

## Your question
${directive.question ?? directive.reason}

## User's answer
${answer}

Continue the task with this answer. Reply with your reasoning and end with one directive JSON object in a \`\`\`json fence (same schema as before: actions ask_user, self_edit, delegate_to_claude, request_claude_revision, run_checks, review_diff, continue_next_phase, declare_complete, stop_blocked, stop_unsafe).`,
    });
    if (!followup.parsed.ok || !followup.parsed.directive) {
      await writeText(join(taskDir, 'codex-followup-raw.txt'), followup.parsed.rawOutput);
      await events.log({
        actor: 'codex',
        action: 'after_user_decision',
        status: 'failed',
        message: 'Codex follow-up returned an invalid directive; stopping as blocked',
      });
      return {
        actor: 'codex',
        action: 'stop_blocked',
        requiresUserInput: false,
        risk: 'medium',
        reason: 'Codex could not produce a valid directive after the user decision',
        successCriteria: [],
        checksToRun: [],
      };
    }
    return followup.parsed.directive;
  }

  private async checkLimits(taskId: string, events: EventLogger): Promise<boolean> {
    const { limits } = this.deps.config;
    const minutes = (Date.now() - this.startedAt) / 60000;
    if (this.modelCalls >= limits.maxTotalModelCalls) {
      await events.log({ actor: 'kairo', action: 'limit', status: 'failed', message: `model-call limit reached (${limits.maxTotalModelCalls})` });
      return false;
    }
    if (minutes >= limits.maxRuntimeMinutes) {
      await events.log({ actor: 'kairo', action: 'limit', status: 'failed', message: `runtime limit reached (${limits.maxRuntimeMinutes} minutes)` });
      return false;
    }
    const task = await this.store.getTask(taskId);
    task.modelCalls = this.modelCalls;
    await this.store.saveTask(task);
    return true;
  }

  private async readPhaseDiff(phaseDir: string): Promise<string> {
    const path = join(phaseDir, 'diff.patch');
    return (await fileExists(path)) ? readText(path) : '';
  }

  private async setOutcome(taskId: string, outcome: string): Promise<void> {
    const task = await this.store.getTask(taskId);
    task.outcome = outcome;
    await this.store.saveTask(task);
  }

  private async finishBlocked(
    taskId: string,
    taskDir: string,
    events: EventLogger,
    phases: PhaseRecord[],
    reason: string,
    extraRisks: string[] = [],
  ): Promise<RunOutcome> {
    await events.log({ actor: 'kairo', action: 'stop_blocked', status: 'completed', message: `stopped: ${reason}` });
    await this.store.transition(taskId, 'blocked');
    await this.setOutcome(taskId, 'blocked');
    const reportPath = await this.writeReport(taskId, taskDir, phases, `Blocked: ${reason}`, extraRisks);
    return { taskId, finalState: 'blocked', outcome: 'blocked', reportPath };
  }

  private async finishFailed(
    taskId: string,
    taskDir: string,
    events: EventLogger,
    phases: PhaseRecord[],
    reason: string,
  ): Promise<RunOutcome> {
    await this.store.transition(taskId, 'failed');
    await this.setOutcome(taskId, 'failed');
    const reportPath = await this.writeReport(taskId, taskDir, phases, `Failed: ${reason}`);
    await events.log({ actor: 'kairo', action: 'report', status: 'completed', message: `report saved: ${reportPath}` });
    return { taskId, finalState: 'failed', outcome: 'failed', reportPath };
  }

  private async finishState(
    taskId: string,
    taskDir: string,
    events: EventLogger,
    phases: PhaseRecord[],
    state: Task['state'],
    reason: string,
  ): Promise<RunOutcome> {
    await events.log({ actor: 'kairo', action: 'pause', status: 'completed', message: reason });
    const reportPath = await this.writeReport(taskId, taskDir, phases, reason);
    return { taskId, finalState: state, outcome: state, reportPath };
  }

  private async writeReport(
    taskId: string,
    taskDir: string,
    phases: PhaseRecord[],
    summary: string,
    extraRisks: string[] = [],
  ): Promise<string> {
    const task = await this.store.getTask(taskId);
    const { events } = await readEventLog(join(taskDir, 'agency-log.ndjson'));
    const changedFiles = [...new Set(phases.flatMap((p) => p.changedFiles))];
    const allCheckResults = phases.flatMap((p) => p.checksRun?.results ?? []);
    // The verdict reflects the FINAL verification state: per check name, only
    // the latest result counts (a transitional phase-1 failure that a later
    // phase fixed must not poison the recommendation; history stays in the
    // event timeline).
    const latestByName = new Map<string, (typeof allCheckResults)[number]>();
    for (const r of allCheckResults) latestByName.set(r.name, r);
    const checkResults = [...latestByName.values()];
    const commandsRun = [...new Set(allCheckResults.map((r) => r.command))];
    const codexReview = phases.map((p) => p.review).filter(Boolean).join('\n\n---\n\n');
    const masterPlanPath = join(taskDir, 'master-plan.md');
    const scope = (await fileExists(masterPlanPath)) ? await readText(masterPlanPath) : '';

    // Assemble real risk evidence. "high:"/"medium:" prefixes drive the
    // commit recommendation in generateReport.
    const risks: string[] = [...extraRisks];
    for (const p of phases) {
      if (p.directiveRisk === 'high') {
        risks.push(`high: phase ${p.phase} directive was flagged high risk by Codex`);
      }
      if (p.reviewRisk === 'high') {
        risks.push(`high: phase ${p.phase} review was flagged high risk by Codex`);
      } else if (p.reviewRisk === 'medium') {
        risks.push(`medium: phase ${p.phase} review was flagged medium risk by Codex`);
      }
      if (!p.diffAvailable) {
        risks.push(
          `high: diff capture was unavailable for phase ${p.phase}${p.diffNote ? ` (${p.diffNote})` : ''} — changed-file evidence relies on agent self-reports`,
        );
      }
    }
    const failedChecks = checkResults.filter((r) => r.status === 'failed' || r.status === 'blocked');
    if (failedChecks.length > 0) {
      risks.push(`high: ${failedChecks.length} check(s) failed or were blocked (${failedChecks.map((r) => r.name).join(', ')})`);
    }
    const skippedChecks = checkResults.filter((r) => r.status === 'skipped');
    if (skippedChecks.length > 0) {
      risks.push(`medium: ${skippedChecks.length} check(s) were skipped (${skippedChecks.map((r) => r.name).join(', ')}) — verify manually`);
    }
    if (reviewMentionsBlockers(codexReview)) {
      risks.push('high: Codex review mentions blockers');
    }

    const diffUnavailable = phases.some((p) => !p.diffAvailable);
    const baselineNote = task.baseline
      ? task.baseline.isGitRepo
        ? `clean working tree at ${task.baseline.branch}@${task.baseline.headSha?.slice(0, 8)} before implementation${task.baseline.dirty ? ' — NO: baseline was dirty (run was blocked)' : ''}`
        : 'not a git repository (run was blocked before implementation)'
      : undefined;

    const report = generateReport({
      task,
      events,
      changedFiles,
      commandsRun,
      checkResults,
      codexReview,
      risks,
      diffUnavailable,
      ...(baselineNote ? { baselineNote } : {}),
      scope: scope.slice(0, 4000),
      summary,
      followUp: [],
    });
    const reportPath = join(taskDir, 'report.md');
    await writeText(reportPath, report);
    return reportPath;
  }
}

/** Everything before the final ```json fence is treated as plan/review prose. */
function extractProse(message: string): string {
  const fenceIndex = message.lastIndexOf('```json');
  if (fenceIndex < 0) {
    const braceIndex = message.lastIndexOf('{');
    return braceIndex > 0 ? message.slice(0, braceIndex).trim() : message.trim();
  }
  return message.slice(0, fenceIndex).trim();
}

/** Pull the structured report section out of Claude's transcript; fall back to the tail. */
function extractClaudeReport(transcript: string): string {
  const match = transcript.match(/# Phase \d+ Report[\s\S]*$/);
  if (match) return match[0].trim();
  const tail = transcript.trim().slice(-3000);
  return tail.length > 0 ? `(no structured report found — transcript tail)\n\n${tail}` : '(empty transcript)';
}
