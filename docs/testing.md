# Testing the Kairo Pipeline

Four levels, ordered by how much setup each needs. Levels 0–2 need **no accounts
and no model calls**; Level 3 talks to real models.

## Level 0 — Automated suite

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

210 unit/integration tests. Most use mocked adapters; adapter/report tests also
cover the Claude transport factory, PTY transport edge cases, terminal-output
sanitization, checkpoint resume, and `kairo ask` audit honesty. This level
covers the orchestrator state machine, directive parsing, safety gate, checks,
diffs, reports, and every control-flow path — but never crosses a real model
boundary.

## Level 1 — CLI smoke (no model CLIs)

Covered automatically by the Level 2 harness scenarios `preflight_nongit`,
`preflight_dirty`, and `missing_codex`. Manual equivalents:

```bash
pnpm build
S=$(mktemp -d) && cd "$S" && git init -q
node <kairo>/dist/cli.js init          # creates config; ignores .kairo/ via .git/info/exclude (tree stays clean)
node <kairo>/dist/cli.js run "x"       # in a dirty/non-git dir => blocked
node <kairo>/dist/cli.js status|logs|inspect|report|check <id>
```

## Level 2 — Stub-CLI end-to-end

```bash
pnpm build
pnpm e2e:stub                 # all 17 scenarios
pnpm e2e:stub happy_delegation self_edit    # subset
KAIRO_E2E_KEEP=1 pnpm e2e:stub plan_pause   # keep sandboxes for inspection
```

`scripts/e2e/run.mjs` runs the **real pipeline** — built CLI, real adapters,
real subprocesses, real git, real checks — against stub `codex`/`claude`
executables (`scripts/e2e/bin/`) that emit deterministic canned behavior.
Interactive scenarios (plan approval, ask_user) run through a real PTY via
node-pty; non-interactive scenarios prove the pause/refuse behavior.

| Scenario | Proves |
|---|---|
| `preflight_nongit` / `preflight_dirty` | run blocks before any model call; codex never invoked |
| `missing_codex` | friendly error naming `codex.command`, exit 1 |
| `happy_delegation` | full artifact tree, real diff captured, checks run, report **safe to commit**, codex sandboxes read-only |
| `self_edit` | separate write-enabled codex session (`workspace-write`), self-edit artifacts, approval gate bypassed, claude never touched |
| `pty_delegation` | the same delegation through `claude.transport: "pty"` — stub claude runs inside a real PTY, transcript streamed to disk, real diff captured |
| `failed_check_revision` | failed check → revision request → second claude run → completed |
| `plan_feedback` | feedback → `plan-feedback` codex call → revised plan + revised instructions reach claude |
| `plan_pause` | non-interactive delegation pauses as `awaiting_plan_approval` |
| `ask_user` | question surfaces on the terminal, answer recorded in user-decisions.md |
| `ask_resume_plan` | non-interactive pause persists `pending`; `kairo ask <id> y` continues to Claude and completion; pending cleared; message logged to user-messages.ndjson |
| `ask_resume_decision` | paused question answered via `kairo ask`; post-decision delegation re-pauses at the plan gate; second `ask approve` completes the task |
| `stop_blocked` / `stop_unsafe` | terminal states + **not safe to commit** |
| `invalid_directive` | prose-only codex output → failed run, raw output saved |
| `claude_missing` | delegation fails visibly with "required for delegated implementation" |
| `self_edit_nodiff` | empty self-edit session fails instead of pretending work happened |

Invariants asserted after every scenario: Kairo never committed (`git rev-list
--count HEAD` unchanged), task ends in a terminal/paused state, every
agency-log line parses, report.md exists.

For **manual** stub-driven exploration: `bash scripts/e2e/setup-sandbox.sh`
prints a ready sandbox plus the env exports to use the stubs.

Note: the harness self-heals node-pty's `spawn-helper` execute bit (pnpm
extracts prebuilds without `+x`, causing `posix_spawnp failed`).

## Level 3 — Real-model end-to-end

Prereqs: `codex` installed and logged in (`codex login status`), `claude`
installed. Validated against codex-cli **0.137.0** and Claude Code **2.1.167**.

**1. Adapter contract probe (cheap, do this first):**

```bash
P=$(mktemp -d) && cd "$P" && git init -q     # codex exec refuses non-git dirs
echo "Reply with exactly: OK" | codex exec --cd "$P" --sandbox read-only --output-last-message /tmp/probe.txt -
cat /tmp/probe.txt
echo "Reply with exactly: OK" | claude -p --permission-mode acceptEdits --model sonnet
```

Probe results so far: both CLIs accept Kairo's exact flag shapes. Learned the
hard way: `codex exec` requires a trusted (git) directory — fine for Kairo,
whose preflight already requires git.

**2. Sandbox:** `bash scripts/e2e/setup-sandbox.sh`, then *skip* the stub env
exports. Consider lowering `limits.maxTotalModelCalls` to ~8 in
`.kairo/config.json` to cap spend.

**3. Runs, in order (each gates the next):**

1. `kairo run "Fix the typo in README.md"` — trivial; expect quick self-edit
   or one delegated phase.
2. `kairo run "Add a greet(name) function in src/ with a test"` — full
   delegation; exercise the approval gate (try feedback once, then approve).
3. Failure path: make the `test` check fail within the task's scope and watch
   the revision loop.

**4. After every run:** `kairo inspect <id>`, read `report.md`, confirm the
recommendation matches the evidence, check `git log` is unchanged, and review
the diff yourself before committing anything.

**Live-run risks the stubs cannot prove:** real Codex emitting schema-valid
directive JSON consistently; `--output-last-message` semantics across codex
versions; claude print mode editing files under `acceptEdits`; adapter
timeouts (20/30 min) being adequate.

### Live-run results (codex-cli 0.137.0, Claude Code 2.1.167)

Seven live runs executed via `scripts/e2e/live-run.mjs` (a PTY driver that
auto-answers the approval prompt — useful for scripted live testing):

```bash
node scripts/e2e/live-run.mjs <sandbox> "<task>" [answerForAskUser]
```

Validated live: quick self-edit (trivial tasks), full Claude delegation with
approval gate (4-file feature), multi-phase with a transitional check failure
(phase 1 breaks the check, phase 2 fixes it), all directives schema-valid in
every run, zero commits by Kairo across all runs.

Findings fixed during live testing:
1. Real Codex emitted `continue_next_phase` without `instructions` (the guard
   blocked correctly) → the directive contract now marks `instructions`
   REQUIRED for implementation-bearing actions.
2. Real Codex sent a command string in `checksToRun` (`"npm test"`), silently
   matching zero checks → unknown names now fall back to running ALL
   configured checks, visibly; the review prompt lists the exact check names.
3. Report verdicts aggregated transitional phase-1 failures forever → the
   commit recommendation now uses the latest result per check name; history
   stays in the event timeline.

### Print + PTY transport validation

After the resumability and PTY stages, live validation was repeated against the
same real CLI versions:

- print transport: PASS across a quick self-edit task and a forced delegated
  multi-file CLI task;
- PTY transport: first failed honestly because real `claude --print` refuses
  prompt input from TTY stdin, then passed after Kairo changed PTY prompt
  delivery to an argv element;
- raw PTY transcripts preserve terminal artifacts, while the text used for
  `claude-report.md` and Codex review is sanitized;
- post-fix verification: `pnpm test` 210/210, `pnpm e2e:stub` 17/17,
  typecheck/lint/build clean.
