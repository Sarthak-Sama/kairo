import { DIRECTIVE_ACTIONS } from './directives.js';
import type { ChecksRun } from './checks.js';
import type { KairoConfig } from './config.js';
import { laneDefinition, laneMenuMarkdown, type QualityLane } from './lanes.js';

/**
 * Lane rubric block for any prompt. `locked` marks an operator-selected lane
 * the head must not change (it may still raise risk or ask_user).
 */
export function renderLaneSection(lane: QualityLane | null, locked: boolean): string {
  if (!lane) return '';
  const def = laneDefinition(lane);
  return `## Quality Lane: ${lane}${locked ? ' (operator-selected — do NOT change it; you may still raise "risk" or use "ask_user")' : ''}

${def.rubric}
Lane-required checks: ${def.requiredChecks.join(', ')}.

`;
}

/**
 * Prompt builders for both agents. Context is reconstructed from artifacts on
 * every call instead of relying on CLI session resume — see docs/architecture.md.
 */

export const DIRECTIVE_CONTRACT = `
You MUST end your reply with exactly one JSON object (a "directive") inside a \`\`\`json code fence.
The directive schema:
{
  "actor": "head",
  "action": one of ${JSON.stringify([...DIRECTIVE_ACTIONS])},
  "taskClass": string (optional, e.g. "quick_self_edit" | "single_phase_dev_lead" | "multi_phase"),
  "phase": positive integer (optional),
  "requiresUserInput": boolean,
  "risk": "low" | "medium" | "high",
  "reason": string (required — why this action),
  "instructions": string (optional — implementation instructions when delegating or self-editing),
  "question": string (optional — required when action is "ask_user"),
  "successCriteria": string[] (optional),
  "checksToRun": string[] (optional — names of configured checks)
}

Rules:
- "actor" MUST be present and MUST be exactly "head" in every directive — it is required, not optional.
- "instructions" is REQUIRED for "self_edit", "delegate_to_development_lead", "request_development_revision", and "continue_next_phase" — it must contain the complete, self-sufficient instructions for that edit/phase/revision. Kairo refuses these actions without instructions.
- "checksToRun" entries must be NAMES from the configured checks list, exactly as listed — never shell commands. Unknown names cause ALL configured checks to run instead.
- "ask_user" is ONLY for product/business/tradeoff/dangerous decisions, never for code-quality questions you can decide yourself.
- "self_edit" only when delegation would clearly waste tokens (tiny scoped change); say so in "reason". Choosing self_edit does NOT mean edit now — Kairo will invoke you again in a separate write-enabled self-edit session. Put the complete edit instructions in "instructions".
- Never instruct anyone to commit. Kairo never auto-commits.
- If the task is unsafe or out of scope, use "stop_unsafe" or "stop_blocked" with a clear reason.
`.trim();

export function buildTriagePrompt(input: {
  taskTitle: string;
  repoScanMarkdown: string;
  config: KairoConfig;
  /** The RESOLVED development-lead provider for this run (profile-aware). */
  developmentLeadProvider: string;
  /** Operator-selected lane, locked for this run; null means the head must classify. */
  selectedLane: QualityLane | null;
}): string {
  const checkNames = input.config.checks.map((c) => c.name).join(', ') || '(none configured)';
  const devLead = input.developmentLeadProvider;
  const laneBlock = input.selectedLane
    ? renderLaneSection(input.selectedLane, true) +
      'The lane above is fixed for this task. Echo it back as "lane" in your directive.\n'
    : `## Quality Lane (you must choose exactly one)
Classify this task into exactly ONE quality lane and put it in your directive as "lane". Explain your choice in "reason".
${laneMenuMarkdown()}
`;
  return `You are the agency head for a local coding task runtime called Kairo.
Your role: inspect the repository, classify the task, and produce a plan plus a directive.
This is a READ-ONLY planning session: you may read files and run non-destructive commands to inspect the repo, but you must not modify anything. If you decide on "self_edit", Kairo will invoke you again in a separate write-enabled session to perform the edits.

## Task from user
${input.taskTitle}

## Repo scan (pre-computed by Kairo)
${input.repoScanMarkdown}

## Configured checks
${checkNames}

${laneBlock}
## What to do
1. Inspect the repo as needed to understand the task's scope. Apply the quality-lane standards above.
2. Classify the task: quick_self_edit (trivial, you do it), single_phase_dev_lead (one implementation phase by the development lead, ${devLead}), or multi_phase.
3. Write a concise master plan in markdown (before your directive): scope, approach, phases if multi-phase, risks.
4. Decide the first action: "self_edit" (Kairo will call you again in a write-enabled self-edit session — put the full edit instructions in "instructions"), "delegate_to_development_lead" (with full implementation instructions for phase 1; the development lead is ${devLead}), "ask_user" (only if a real product/tradeoff decision is needed first), or "stop_blocked"/"stop_unsafe".

${DIRECTIVE_CONTRACT}`;
}

/** Bound for the user-decisions section included in model prompts. */
export const USER_DECISIONS_CHAR_LIMIT = 10_000;

/**
 * Render the binding-decisions section (dogfood fix: the stateless reviewer
 * re-asked questions the user had already answered because decisions never
 * reached its context). Tail-biased truncation — recent decisions win.
 */
export function renderUserDecisionsSection(userDecisions: string): string {
  const trimmed = userDecisions.trim();
  if (!trimmed) return '';
  const bounded =
    trimmed.length <= USER_DECISIONS_CHAR_LIMIT
      ? trimmed
      : `(earlier decisions truncated)\n…${trimmed.slice(-USER_DECISIONS_CHAR_LIMIT)}`;
  return `## User Decisions Already Made

These are binding product/business decisions for this task. Do not ask the same question again unless the implementation introduces a genuinely new ambiguity.

${bounded}

`;
}

/** Bound for the manager-notes section included in model prompts. */
export const MANAGER_NOTES_CHAR_LIMIT = 6_000;

/**
 * Supervision notes left via `kairo note` — context, not commands or answers.
 * Tail-biased truncation; recent notes win.
 */
export function renderManagerNotesSection(notes: string): string {
  const trimmed = notes.trim();
  if (!trimmed) return '';
  const bounded =
    trimmed.length <= MANAGER_NOTES_CHAR_LIMIT
      ? trimmed
      : `(earlier notes truncated)\n…${trimmed.slice(-MANAGER_NOTES_CHAR_LIMIT)}`;
  return `## Recent Manager Notes

Supervision context from the user. These are NOT answers to pending questions and NOT new requirements unless they clarify scope — but respect explicit constraints stated here.

${bounded}

`;
}

export function buildReviewPrompt(input: {
  taskTitle: string;
  phase: number;
  masterPlan: string;
  claudeReport: string;
  diffPatch: string;
  checksRun: ChecksRun | null;
  revisionCount: number;
  maxRevisions: number;
  configuredCheckNames: string[];
  userDecisions?: string;
  managerNotes?: string;
  lane?: QualityLane | null;
}): string {
  const laneReview = input.lane
    ? `## Quality Lane: ${input.lane}\nReview focus: ${laneDefinition(input.lane).reviewFocus}\nLane-required checks: ${laneDefinition(input.lane).requiredChecks.join(', ')}.\n\n`
    : '';
  const checksSummary = input.checksRun
    ? input.checksRun.results
        .map((r) => `- ${r.name}: ${r.status}${r.detail ? ` (${r.detail})` : ''}`)
        .join('\n')
    : '(checks not run)';
  const diff = truncate(input.diffPatch, 60000) || '(no diff captured)';
  return `You are the agency head reviewing an implementation phase for the task below.

## Task
${input.taskTitle}

## Phase under review
Phase ${input.phase} (revision ${input.revisionCount} of max ${input.maxRevisions})

## Master plan
${input.masterPlan || '(no master plan recorded)'}

${laneReview}${renderUserDecisionsSection(input.userDecisions ?? '')}${renderManagerNotesSection(input.managerNotes ?? '')}## Implementer report (development lead)
${input.claudeReport || '(no report)'}

## Check results
${checksSummary}

## Configured checks (use these exact names in "checksToRun")
${input.configuredCheckNames.join(', ') || '(none configured)'}

## Diff
\`\`\`diff
${diff}
\`\`\`

## What to do
Review the diff against the plan and success criteria. Then choose exactly one action:
- "request_development_revision" — for code-quality issues, bugs, failed checks, or scope drift. Put concrete revision instructions in "instructions".
- "ask_user" — ONLY if a product/business/tradeoff decision emerged.
- "continue_next_phase" — phase is good and more phases remain in the plan.
- "declare_complete" — the whole task is done and verified.
- "stop_blocked" / "stop_unsafe" — if continuing is impossible or unsafe.

${DIRECTIVE_CONTRACT}`;
}

export function buildDevelopmentLeadPrompt(input: {
  taskTitle: string;
  phase: number;
  instructions: string;
  successCriteria: string[];
  masterPlan: string;
  isRevision: boolean;
  previousReport?: string;
  userDecisions?: string;
  managerNotes?: string;
  lane?: QualityLane | null;
}): string {
  const criteria =
    input.successCriteria.length > 0
      ? input.successCriteria.map((c) => `- ${c}`).join('\n')
      : '(none specified — use your judgment against the plan)';
  const revisionBlock = input.isRevision
    ? `\n## This is a REVISION request\nYour previous report:\n${input.previousReport ?? '(unavailable)'}\n\nAddress the revision instructions below. Do not redo work that was accepted.\n`
    : '';
  return `You are the development lead for one phase of a coding task, working under an external reviewer.

## Task
${input.taskTitle}

## Master plan (from the reviewer)
${input.masterPlan || '(no plan — single phase task)'}

${renderLaneSection(input.lane ?? null, false)}${renderUserDecisionsSection(input.userDecisions ?? '')}${renderManagerNotesSection(input.managerNotes ?? '')}${revisionBlock}
## Phase ${input.phase} instructions
${input.instructions}

## Success criteria
${criteria}

## Hard rules
- Implement ONLY this phase. No unrelated refactors, no drive-by cleanups.
- Do NOT commit. Do not run git commit, push, reset, or clean.
- You may use your own subagents/tools if your environment provides them.

## Required report
End your reply with a markdown report in exactly this structure:

# Phase ${input.phase} Report
## Changed Files
(list every file you created/modified/deleted)
## Commands Run
(list shell commands you ran)
## Risks
(known risks, shortcuts, or follow-ups; "none" if none)
## Phase Complete
yes / no — with one line of justification`;
}

export function buildSelfEditPrompt(input: {
  taskTitle: string;
  phase: number;
  instructions: string;
  masterPlan: string;
  userDecisions?: string;
  managerNotes?: string;
  lane?: QualityLane | null;
}): string {
  return `You are the agency head for Kairo, now in a WRITE-ENABLED self-edit session.
During planning you decided this change is small enough to make yourself. Make exactly those edits now.

## Task
${input.taskTitle}

## Your plan
${input.masterPlan || '(no plan prose recorded)'}

${renderLaneSection(input.lane ?? null, false)}${renderUserDecisionsSection(input.userDecisions ?? '')}${renderManagerNotesSection(input.managerNotes ?? '')}## Edit instructions (from your own triage directive)
${input.instructions}

## Hard rules
- Make ONLY the edits described above. No unrelated changes.
- Do NOT commit. Do not run git commit, push, reset, or clean.

## Required final message
End with a short markdown summary: what you changed, which files, and any caveats. Kairo captures the working-tree diff separately and will have your edits reviewed.`;
}

export function buildAfterUserDecisionPrompt(input: {
  taskTitle: string;
  masterPlan: string;
  phaseContext: string;
  question: string;
  answer: string;
  userDecisions?: string;
  managerNotes?: string;
  lane?: QualityLane | null;
  laneLocked?: boolean;
}): string {
  return `You previously asked the user a question while working on the task below.

## Task
${input.taskTitle}

## Master plan
${input.masterPlan}

${renderLaneSection(input.lane ?? null, input.laneLocked ?? false)}${renderUserDecisionsSection(input.userDecisions ?? '')}${renderManagerNotesSection(input.managerNotes ?? '')}## Work completed so far
${input.phaseContext}

## Your question
${input.question}

## User's answer
${input.answer}

Continue the task with this answer. Reply with your reasoning and end with one directive JSON object.

${DIRECTIVE_CONTRACT}`;
}

export function buildPlanFeedbackPrompt(input: {
  taskTitle: string;
  masterPlan: string;
  feedback: string;
  lane?: QualityLane | null;
  laneLocked?: boolean;
}): string {
  return `You are the agency head for Kairo. The user reviewed your plan for the task below and sent feedback instead of approving it. Revise your plan/directive accordingly.

## Task
${input.taskTitle}

## Your current plan
${input.masterPlan}

${renderLaneSection(input.lane ?? null, input.laneLocked ?? false)}## User feedback on the plan
${input.feedback}

Reply with your revised reasoning and end with one directive JSON object.

${DIRECTIVE_CONTRACT}`;
}

/**
 * One-shot recovery prompt: Codex's previous output failed directive
 * validation (dogfood evidence: a substantively correct directive missing the
 * required "actor" field). Codex is stateless, but its own raw output carries
 * its full reasoning — ask it to re-emit the same decision validly.
 */
export function buildDirectiveRetryPrompt(input: {
  purpose: string;
  validationError: string;
  rawOutput: string;
}): string {
  return `Your previous response to a Kairo "${input.purpose}" request could not be used because it failed directive validation.

## Validation error
${input.validationError}

## Your previous output (for reference — your decision was likely fine; the FORMAT was not)
${input.rawOutput.slice(0, 20000)}

Re-state the SAME decision as exactly one valid directive JSON object in a \`\`\`json fence. Do not change your decision; fix the format. Every required field must be present.

${DIRECTIVE_CONTRACT}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '\n… (diff truncated for review)';
}
