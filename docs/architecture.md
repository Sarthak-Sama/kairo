# Kairo Architecture

## The three roles

| Role | Who | Responsibility |
|---|---|---|
| Agency contact layer | **Kairo** | Session management, state machine, artifacts, event log, safety gates, checks, diffs, reports, user interaction |
| Agency head | **Codex CLI** | Repo inspection, task classification, planning, diff review, revision requests, completion decisions |
| Implementation lead | **Claude Code** | Phase implementation, its own subagents, implementation reports |

Kairo never makes technical judgments itself. It executes a protocol: it validates what Codex decides, runs what needs running, captures what happened, and routes real decisions to the user.

## Module map

```
src/cli.ts                 commander entry point
src/commands/*             one file per CLI command, thin over core
src/core/
  orchestrator.ts          the agency loop (the only place control flow lives)
  config.ts                zod-validated .kairo/config.json
  task-store.ts            file-backed task state + state history
  events.ts                append-only NDJSON audit log
  directives.ts            directive schema + tolerant JSON extraction
  prompts.ts               prompt builders for both agents
  repo-scanner.ts          fast-glob repo survey -> repo-scan.md
  checks.ts                check runner (passed/failed/skipped/blocked)
  diff.ts                  git baseline + working-tree diff capture
  report.ts                report.md generation + commit recommendation
  safety.ts                destructive-command blocklist
src/adapters/
  process-runner.ts        single choke-point for all shell execution
  codex.ts                 codex exec wrapper -> directives
  claude.ts                claude -p wrapper -> transcripts
src/renderers/timeline.ts  live one-line-per-event timeline
```

## The directive protocol

Codex does not free-form drive anything. Every Codex invocation must end with a single JSON directive that Kairo validates against a zod schema (`src/core/directives.ts`). Allowed actions:

`ask_user`, `self_edit`, `delegate_to_claude`, `request_claude_revision`, `run_checks`, `review_diff`, `continue_next_phase`, `declare_complete`, `stop_blocked`, `stop_unsafe`.

The parser is tolerant about *where* the JSON appears (fenced block, bare object, embedded in prose) but strict about *what* it contains. If no valid directive can be extracted, Kairo saves the raw output to the task folder (`codex-triage-raw.txt` / `codex-review-raw.txt`), logs a failed event pointing at it, and fails the run visibly. It never guesses what Codex meant.

## The recursive loop

```
preflight (kairo) ── git repo? clean tree? ──► blocked if not
   │
   ▼
triage (codex, read-only) ──► directive
                     │
   ┌─────────────────┼───────────────────────────┐
   ▼                 ▼                           ▼
ask_user        plan approval gate          stop_blocked /
(user gate)     (user: approve / feedback   stop_unsafe /
   │             / pause) for non-trivial   declare_complete
   │             work                            │
   └──► codex        │                           ▼
        follow-up    ▼                       final report
                    implement ──► capture diff
                    (claude, or a separate
                     write-enabled codex
                     self-edit session)
                     │
                     ▼
                    run checks ──► codex review (read-only) ──► next directive
```

Each pass through implement→review is bounded by `limits.maxRevisionLoopsPerPhase`; phases are bounded by `limits.maxPhases`; everything is bounded by `limits.maxTotalModelCalls` and `limits.maxRuntimeMinutes`. Hitting a limit ends the run as `blocked` with a report — never a silent stall.

Codex may choose `self_edit` when delegation would waste tokens (it says so in the directive's `reason`). Planning is strictly read-only, so choosing self_edit does not perform the edit: Kairo runs a *separate* write-enabled Codex session with the directive's instructions, captures its prompt and final message into the phase folder, and fails the run if the session produced no diff. The pipeline does not branch around safety for this: Kairo still captures the diff, runs checks, and has Codex review its own edit.

### Sandbox discipline

| Codex call | Sandbox |
|---|---|
| triage / plan-feedback / review / after-user-decision | `read-only` |
| dedicated self-edit session | configured write sandbox (`workspace-write`) |

Claude's write access is governed by Claude Code's own permission mode.

## The artifact ledger

The design rule is: **every meaningful decision leaves a file.** State transitions are persisted to `task.json` before the next step runs; events are appended to `agency-log.ndjson` as they happen. A crash mid-run therefore leaves a coherent, inspectable trail rather than a mystery.

This is also the session strategy — and it is a deliberate **v0 degraded mode**, not the end state. The product direction is persistent agency sessions; today, instead of depending on Codex/Claude CLI session resume (which varies across CLI versions), every Codex call is a fresh stateless invocation given reconstructed context from artifacts: the repo scan, the master plan, the implementer's report, the diff, and check results. Session metadata is still recorded (`codex-session.json`, `claude-session.json`) for inspection. Persistent sessions and the node-pty Claude adapter are the next major upgrades (see docs/limitations.md).

## Execution safety

All shell execution flows through one choke point: `ExecaProcessRunner.runShell`. It applies the destructive-command blocklist (`src/core/safety.ts`) unless the caller explicitly marks a command as Kairo-composed (used only for read-only git commands and the adapter invocations themselves, whose arguments come from validated config — and whose sandboxing is delegated to Codex's sandbox and Claude's permission system respectively).

## Why Kairo does not auto-commit

1. A commit is a statement that a human accepts the change. Kairo's whole output is a *recommendation* (`safe to commit` / `needs manual review` / `not safe to commit`) with the evidence attached — making the commit itself would erase the boundary the tool exists to maintain.
2. Reverting an uncommitted working-tree change is trivial and local. Reverting a commit (or worse, a push) is not.
3. It keeps the failure domain small: the worst a bad run can do is leave a dirty working tree and a report explaining itself.

`git commit` is on the blocklist, and both agent prompts state the rule explicitly.
