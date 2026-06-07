# Kairo

Kairo is a CLI-first, local agency runtime that sits between you and AI coding tools.

You give Kairo a task. Kairo coordinates **Codex CLI** as the agency head (planning, repo inspection, review, completion decisions) and **Claude Code** as the implementation lead (build work, revisions, implementation reports). Kairo itself is the operating layer: session management, live timeline, artifacts, logs, safety gates, checks, and reports.

```bash
kairo run "Build a keyboard shortcut helper modal"
```

The core loop:

```
user task
  -> Kairo creates a task run (requires a git repo with a clean working tree)
  -> Codex inspects the repo (read-only) and classifies the work
  -> Codex creates a plan / directive
  -> Kairo asks you to approve the plan for non-trivial work
  -> Kairo asks the user only when a real product/tradeoff decision is needed
  -> Kairo delegates implementation to Claude Code when appropriate
     (or runs a separate write-enabled Codex self-edit session for tiny changes)
  -> Claude implements and reports
  -> Kairo captures transcript, diff, checks
  -> Codex reviews (read-only)
  -> Codex decides: complete / revise / continue / ask user / stop
  -> repeat until complete or blocked
```

## What Kairo is

- A local CLI tool. Everything runs on your machine.
- An orchestration layer over two existing CLIs (`codex`, `claude`).
- An artifact ledger: every meaningful decision is written to `.kairo/` as a file you can read.

## What Kairo is not

- Not a web UI, not SaaS, no auth, no billing, no telemetry.
- Not an "AI employee". It is a task runner with a review loop.
- Not an agent framework. No LangChain. Plain TypeScript, explicit control flow.
- Not a commit bot. **Kairo never commits.** It tells you whether the diff looks safe to commit and leaves the decision to you.

## Requirements

- Node.js >= 20
- pnpm
- [Codex CLI](https://github.com/openai/codex) on your PATH (`codex`)
- [Claude Code](https://claude.com/claude-code) on your PATH (`claude`)

## Install / develop

```bash
pnpm install
pnpm build          # compile to dist/
pnpm test           # vitest (no real model calls; adapters are mocked)
pnpm typecheck
pnpm lint

# run from source during development
pnpm dev -- --help

# or link the built CLI
pnpm link --global
kairo --help
```

## Example workflow

```bash
cd your-project
kairo init                                   # creates .kairo/config.json, ignores .kairo/ via .git/info/exclude
kairo run "Add input validation to the signup form"
# ... live timeline:
# [kairo] task created: 20260606-161530-add-input-validation-to-the-signup
# [codex] inspecting repo
# [codex] classified task: single_phase_claude
# [codex] plan ready
# [claude] implementing phase 1
# [kairo] capturing diff
# [checks] running checks
# [codex] reviewing implementation
# [codex] task complete
# [kairo] report saved: .kairo/tasks/.../report.md

kairo status                                 # list tasks and states
kairo logs <task-id>                         # full agency event log
kairo inspect <task-id>                      # task details, pending decision, artifact tree
kairo check <task-id>                        # re-run configured checks
kairo report <task-id>                       # print the final report

# paused tasks (plan approval / codex question) are continuable:
kairo resume <task-id>                       # interactive: shows the plan/question, prompts you
kairo ask <task-id> "y"                      # non-interactive: approve a pending plan
kairo ask <task-id> "Make it smaller"        # ...or send plan feedback / answer a question
```

A paused task persists exactly what it is waiting for in `task.json` (`pending`). `kairo ask` answers one pending interaction per call — if the continuation pauses again (e.g. a revised plan needs approval), ask again. Messages sent via `ask` are recorded in `user-messages.ndjson`; a message to a task with nothing pending is recorded as a note and runs nothing.

Task IDs accept unique fragments: `kairo logs signup` works if only one task matches.

## Configuration

`kairo init` writes `.kairo/config.json`. Notable settings:

- `limits` — hard caps on phases, revision loops per phase, total model calls, and runtime minutes. The run stops as `blocked` when a limit is hit.
- `checks` — shell commands run after each implementation phase (typecheck/lint/test/build by default). Checks whose binary or package script doesn't exist are recorded as **skipped**, never as failed.
- `roles` — which provider fills each agency role: `{ "head": "codex" | "claude", "developmentLead": "codex" | "claude" }`. Defaults preserve the original team (Codex head, Claude development lead). `{ "head": "claude", "developmentLead": "claude" }` runs the whole agency on Claude alone — no Codex required. When Claude is head, its planning/review calls use `claude.headPermissionMode` (default `"plan"`); implementation keeps `claude.permissionMode`. Codex head calls stay read-only sandboxed; Codex as development lead gets the write sandbox only during implementation.
- `codex` / `claude` — command names, model, sandbox/permission mode.
- `claude.transport` — `"print"` (default, proven `claude -p` subprocess) or `"pty"` (opt-in: same public print-mode command inside a real pseudo-terminal, with the transcript streamed to disk as it arrives). PTY is a transport foundation only — it is **not** persistent sessions, live message injection, or interactive permission-prompt control. It requires the optional `node-pty` dependency and fails with a clear message if that is missing.
- `scanner.exclude` — globs excluded from the repo scan.

## Safety model

- **Git required, clean tree required.** `kairo run` refuses to start in a non-git directory (Kairo needs diff accountability — every change must be attributable to the task) and refuses to start on a dirty working tree (so your unrelated work is never mixed into a task's diff). Commit or stash first; Kairo never stashes, cleans, or commits for you.
- **Plan approval gate.** Non-trivial work (Claude delegation, anything high-risk, anything Codex classifies as a real feature/phase) requires you to approve the master plan before implementation. Answer `y` to approve, send feedback to get a revised plan, or press enter to pause the task as `awaiting_plan_approval`. Only quick, low-risk Codex self-edits skip the gate.
- **Read-only planning.** Codex triage, review, and decision calls run with a read-only sandbox. Only the dedicated self-edit session (after approval rules pass) gets write access — and if it produces no diff, the run fails instead of pretending work happened.
- **No auto-commit.** `git commit` is on the blocklist for any command Kairo runs, and both agents are explicitly instructed not to commit.
- **Destructive command gate.** Every shell command Kairo executes passes through a blocklist (`git reset --hard`, `git clean`, force pushes, `rm -rf`, `sudo`, recursive `chmod`/`chown`, `dd`, `mkfs`). A check configured with a destructive command is recorded as `blocked` and never executed. The matcher is deliberately conservative: it will also block dangerous text inside quoted strings.
- **Claude-side commands** are governed by Claude Code's own permission system (`permissionMode` in config).
- **Codex-side commands** run inside Codex's own sandbox (`workspace-write` by default).
- **User gate.** Product, business, tradeoff, or dangerous decisions are routed to you via `ask_user` directives. In a non-interactive session the task pauses as `awaiting_user_decision` instead of guessing.
- **Audit trail.** Every event lands in `.kairo/tasks/<id>/agency-log.ndjson`; every phase keeps the directive, prompt, transcript, diff, check results, review, and decision as files.

## Artifact layout

```
.kairo/
  config.json
  tasks/
    <task-id>/
      task.json              # canonical task state + history
      agency-log.ndjson      # audit trail, one event per line
      repo-scan.md           # what Codex was shown about the repo
      master-plan.md         # Codex's plan prose
      user-decisions.md      # questions asked + your answers
      codex-session.json
      claude-session.json
      phase-001/
        codex-directive.json
        claude-prompt.md            # Claude path
        claude-transcript.log
        claude-report.md
        codex-self-edit-prompt.md   # Codex self-edit path
        codex-self-edit-transcript.md
        diff.patch
        checks.json
        checks.log
        codex-review.md
        codex-decision.json
      report.md              # final report with commit recommendation
  logs/
```

`kairo init` keeps `.kairo/` out of version control via `.git/info/exclude` — the local, untracked equivalent of `.gitignore`. It deliberately does **not** create or modify `.gitignore`: that would itself be an uncommitted change, which the next `kairo run` would block on (clean-tree gate). If your `.gitignore` or exclude file already covers `.kairo/`, init leaves everything alone. Add `.kairo/` to `.gitignore` yourself if you want the rule shared with collaborators.

## Current limitations

See [docs/limitations.md](docs/limitations.md) for the honest list. Headlines:

- **This is a v0 degraded session mode.** The product direction is persistent agency sessions; today each Codex call is a fresh `codex exec` with context reconstructed from artifacts, and Claude uses one-shot `claude -p` sessions through either the default print transport or the opt-in PTY transport. True persistent Codex/Claude sessions and live message injection are *not* implemented.
- `kairo resume`/`kairo ask` continue tasks paused at checkpoints (plan approval, codex questions). They do **not** inject messages into an actively running model call — checkpoint resumability only.
- `kairo run` requires a git repository with a clean working tree (by design — see Safety model). Resuming a task that already ran implementation phases is allowed with a dirty tree (Kairo's own changes), recorded as a risk in the report.
