# Kairo Pipeline Test Report

**Date:** 2026-06-07
**Version under test:** kairo 0.1.0 (unreleased, local)
**Verdict:** PASS at all four levels — ready for broader real-world use within documented v0 limitations.

## 1. Environment

| Component | Version |
|---|---|
| OS | macOS (Darwin 25.0.0, arm64) |
| Node.js | v22.22.2 |
| pnpm | 11.5.1 |
| Codex CLI (live runs) | codex-cli 0.137.0, authenticated via ChatGPT |
| Claude Code (live runs) | 2.1.167 |
| Codebase size | 3,939 lines src/ · 2,588 lines tests/ |

## 2. Test strategy

Four levels, each adding a real boundary the previous level mocked:

| Level | Boundary added | Cost |
|---|---|---|
| L0 — automated suite | none (in-memory mocks) | free, ~1s |
| L1 — CLI smoke | real CLI process, real filesystem | free, seconds |
| L2 — stub-CLI E2E | real subprocesses, real git, real checks, real PTY | free, ~1 min |
| L3 — live E2E | real Codex + Claude models | model tokens, minutes/run |

## 3. Level 0 — Automated suite

**Result: 210/210 tests passed, 17 test files. `tsc --noEmit`, ESLint, and build all clean.**

| File | Tests | Covers |
|---|---|---|
| safety.test.ts | 45 | destructive-command blocklist incl. bypass attempts (`rm -Rf`, split flags, `command`/`env`/var-prefix laundering), git-commit blocking |
| orchestrator.test.ts (integration) | 34 | every loop path with mocked adapters: preflights, approval gate (approve/feedback/pause/bypass), self-edit split + sandbox discipline, delegation, revision loop + limits, multi-phase, transitional-failure verdicts, unknown check names, ask_user, blocked/unsafe/invalid-directive/claude-missing failure paths, risk-driven reports |
| report.test.ts | 18 | commit-recommendation rules (safe / manual review / not safe), all report sections, blocker negation ("no blockers") |
| directives.test.ts | 12 | schema validation, JSON extraction from fences/prose/bare objects, malformed-output failure modes |
| resume.test.ts (integration) | 12 | checkpoint resumability from plan approval and user decisions, phase reconstruction on resume, dirty-tree resume rules, inspect pending metadata |
| task-store.test.ts | 10 | state model, pending metadata, history, persistence, partial-ID resolution |
| claude-adapters.test.ts | 10 | Claude adapter factory, PTY availability, argv prompt delivery, prompt-size guard, timeout/non-zero/spawn-failure behavior |
| config.test.ts | 10 | schema defaults, invalid JSON/shape errors with `kairo init` guidance, Claude transport validation |
| checks.test.ts | 9 | pass/fail/skip semantics, missing binaries & scripts, blocked destructive checks, unknown `only` names fallback |
| init.test.ts | 8 | config creation, `.git/info/exclude` ignore behavior, idempotency, non-git behavior |
| diff.test.ts | 8 | baseline capture, porcelain parsing (quoted/unicode/renamed paths), shell-safe untracked-file diffs |
| phase-reconstruction.test.ts | 7 | phase artifact reconstruction, changed-file extraction from patches, missing-artifact placeholders |
| prompts.test.ts | 6 | read-only triage contract, instructions-REQUIRED rule, self-edit prompt |
| events.test.ts | 6 | NDJSON append/replay, malformed-line surfacing, listener fan-out |
| claude-report-extraction.test.ts | 6 | report extraction from print/PTY transcripts, final-header selection, ANSI/OSC/control-byte sanitization |
| ask-audit.test.ts (integration) | 5 | `kairo ask` records handled/unhandled messages honestly across success, missing Codex, and resume refusal |
| process-runner.test.ts | 4 | `commandExists` shell-injection regressions (executed for real) |

## 4. Level 1 — CLI smoke

Automated inside the L2 harness (`preflight_nongit`, `preflight_dirty`, `missing_codex`) plus manual passes earlier. **All passed:** `kairo init` idempotency + gitignore handling; non-git and dirty-tree runs blocked before any model call with correct exit codes; missing Codex produces a config-pointing error; `status`/`logs`/`inspect`/`report`/`check` behave on real task folders, including partial-ID matching and clean errors on bogus IDs.

## 5. Level 2 — Stub-CLI end-to-end

`pnpm e2e:stub` — **17/17 scenarios passed.** Stub `codex`/`claude` executables (`scripts/e2e/bin/`) implement Kairo's exact CLI contracts; everything else is real: `ExecaProcessRunner`, both Claude transports, adapter selection, flag construction, stdin/argv prompt delivery, `--output-last-message` files, git diff capture, check execution, artifact writing, and PTY-interactive approval prompts.

| Scenario | Verified |
|---|---|
| preflight_nongit / preflight_dirty | blocked before any model call; codex invocation count = 0; no stash/clean/commit |
| missing_codex | friendly error naming `codex.command`, exit 1 |
| happy_delegation | 12-artifact tree, real diff content, checks ran, report **safe to commit**, baseline note, sandboxes `triage:read-only → review:read-only` (asserted from stub argv logs) |
| self_edit | separate write session (`workspace-write`), self-edit artifacts, approval bypassed, Claude untouched |
| pty_delegation | delegated implementation through `claude.transport: "pty"`, real PTY subprocess, streamed transcript, real diff |
| failed_check_revision | fail → `request_claude_revision` → second Claude run (revision flag set) → complete |
| plan_feedback | feedback → `plan-feedback` Codex call → revised master-plan.md → revised instructions reached Claude → recorded in user-decisions.md |
| plan_pause | non-interactive delegation pauses `awaiting_plan_approval`, report written, no Claude call |
| ask_user | question rendered on terminal, PTY answer captured, Q&A in user-decisions.md |
| ask_resume_plan | non-interactive plan pause persists `pending`; `kairo ask <id> y` resumes through Claude and clears pending |
| ask_resume_decision | paused Codex question answered via `kairo ask`; post-decision plan gate re-pauses; second ask completes |
| stop_blocked / stop_unsafe | correct terminal states/outcomes, **not safe to commit** |
| invalid_directive | failed run, raw output saved to codex-triage-raw.txt |
| claude_missing | fails at delegation with "required for delegated implementation", report written, no crash |
| self_edit_nodiff | empty self-edit session fails the run instead of faking progress |

**Invariants asserted after every scenario:** commit count unchanged (Kairo never commits) · task ends in a terminal/paused state with history starting at `created` · every agency-log line parses as JSON · report.md exists.

## 6. Level 3 — Live end-to-end (real models)

### 6.1 Contract probes
`codex exec --cd … --sandbox read-only --output-last-message … -` and `claude -p --permission-mode acceptEdits --model sonnet` both accepted Kairo's exact flag shapes and returned expected output. Learned: `codex exec` requires a trusted (git) directory — compatible with Kairo's preflight, now documented.

### 6.2 Live runs (7)

| Run | Task | Path exercised | Outcome |
|---|---|---|---|
| 1 | fix README typo | triage → `quick_self_edit` (gate bypassed) → write-enabled self-edit session → diff → checks → review → complete | ✅ typo fixed, scoped 1-line diff, **safe to commit** |
| 2 | add greet() + test | self-edit again (Codex judged delegation wasteful — defensible) | ✅ working code, **safe to commit** |
| 3 | multi-file CLI calculator | `single_phase_claude` → **approval gate fired** → **real Claude implemented 4 files** → checks → review | ✅ working calculator incl. divide-by-zero handling, structured phase report parsed, **safe to commit** |
| 4 | rename fn (trap v1) | trap defeated honestly: positional export survives rename; check legitimately passed | ✅ correct behavior, not a defect |
| 5 | rename fn (trap v2, named export) | **check failed live** → Codex chose `continue_next_phase` **without instructions** → stale-instructions guard blocked the run | ⚠️ exposed Defect L-1; guard + not-safe report worked as designed |
| 6 | retry after L-1 fix | **full multi-phase live**: phase-1 fail → continue *with* instructions → Claude phase 2 → complete | ⚠️ exposed Defects L-2, L-3 |
| 7 | final validation | same trap, all fixes: phase 2 ran checks (`checksToRun: ["test"]` — correct name), green tree | ✅ **safe to commit**, all three fixes confirmed live |

**Cross-run invariants:** Kairo made **zero commits** across all 7 runs (every sandbox commit was a deliberate user action) · **all ~16 real Codex directives were schema-valid JSON on the first attempt** (the largest pre-test unknown) · every run produced a complete artifact trail and report · every failure was visible in the timeline and event log.

### 6.3 Defects found by live testing — all fixed + regression-tested

| ID | Defect | Fix | Regression test |
|---|---|---|---|
| L-1 | Directive contract never said `instructions` is mandatory; real Codex emitted a reasoned `continue_next_phase` without them and the run blocked unnecessarily | contract now marks `instructions` REQUIRED for all implementation-bearing actions | prompts.test.ts; validated live (runs 6–7) |
| L-2 | Codex sent a command string (`"npm test"`) in `checksToRun`; the name filter silently matched zero checks — verification skipped invisibly | unknown names now fall back to running ALL configured checks with a visible event; review prompt lists exact configured names | checks.test.ts ×2, orchestrator.test.ts; validated live (run 7) |
| L-3 | A transitional phase-1 check failure (fixed by phase 2) forced *not safe to commit* despite a green final tree | verdict now uses the latest result per check name; history remains in the event timeline | orchestrator.test.ts; validated live (run 7) |

### 6.4 Print + PTY transport validation

After resumability and the Claude PTY transport stage, live validation was repeated against `codex-cli 0.137.0` and Claude Code `2.1.167` using the built CLI from `dist/`.

| Transport | Result | Evidence |
|---|---|---|
| print (default) | PASS | quick self-edit task and forced multi-file Claude delegation both completed; `.git/info/exclude` init behavior kept the tree clean; reports were coherent and **safe to commit** |
| PTY (opt-in) | FAIL → FIXED → PASS | first real run exposed that `claude --print` refuses TTY stdin; PTY now passes the prompt as an argv element, rejects prompts over ~180KB with print-mode guidance, preserves raw transcript, and sanitizes text used for `claude-report.md` and Codex review |

Post-fix verification: `pnpm test` **210/210**, `pnpm e2e:stub` **17/17**, `pnpm typecheck`, `pnpm lint`, and `pnpm build` clean.

### 6.5 Issues found while building the harness

| ID | Issue | Status |
|---|---|---|
| H-1 | `kairo init` created an **untracked** `.gitignore`, so the very next `kairo run` was blocked by the dirty-tree gate | **FIXED** (post-report): init now uses `.git/info/exclude` and never touches `.gitignore`; covered by 8 unit tests (init.test.ts) and the E2E harness, which no longer needs its pre-committed-gitignore workaround |
| H-2 | pnpm extracts node-pty's prebuilt `spawn-helper` without the execute bit → `posix_spawnp failed` | harness self-heals (chmod at startup) |
| H-3 | `codex exec` refuses untrusted (non-git) directories | benign for Kairo; documented |

## 7. Coverage gaps (honest)

- **`request_claude_revision` live:** real Codex preferred `continue_next_phase` over a revision request in the engineered failure; the revision loop is verified at L0 (mocked) and L2 (stub) only.
- **`ask_user` and plan-feedback live:** never naturally triggered; verified at L0/L2.
- **Limits under live load** (maxPhases/maxRevisions/model calls/runtime): L0/L2 only.
- **Claude interactive permission prompts:** untestable by design in v0 print mode (documented limitation).
- **PTY soak testing:** validated with one real smoke pass; print remains default until PTY has more mileage.
- **Long/concurrent runs:** single-task, short-run testing only; no locking exists (documented).

## 8. Defect history across the whole effort (context)

29 defects found and fixed before live testing across three review rounds — including 4 high-severity safety-gate bypasses (`rm -Rf`, split flags, `command`/env-prefix laundering), shell-injection vectors in both adapters and `commandExists`, the unused plan-approval states, the triage/self-edit sandbox contradiction, and risk-blind reports. Live testing then found 3 more (L-1…L-3, §6.3), the fresh-repo init issue (H-1), and the real-Claude PTY prompt-delivery issue (§6.4). Every fixed defect has a regression test.

## 9. Reproduction

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build   # L0
pnpm e2e:stub                                            # L1+L2 (17 scenarios)
bash scripts/e2e/setup-sandbox.sh                        # L3 sandbox (real CLIs)
node scripts/e2e/live-run.mjs <sandbox> "<task>"         # L3 driver (auto-approves plan)
```

## 10. Recommendations

1. ~~Fix H-1 (`kairo init` gitignore vs dirty-gate)~~ — **done** (see §6.4).
2. ~~Add `kairo resume`~~ — **done**: `kairo resume` and `kairo ask` provide checkpoint resumability for plan approval and Codex questions.
3. ~~Validate Claude PTY transport against real Claude~~ — **done**: opt-in PTY transport passed live smoke testing after the argv prompt-delivery fix; print remains default.
4. Run `pnpm e2e:stub` in CI; keep live runs manual and budgeted.
5. Next product stage: run observability/control (better live status, transcript/log tailing, and clean interruption), not persistent sessions yet.
