# Known Limitations

This is the honest list for the current version (0.1.0).

## This is a v0 degraded session mode

The intended product is a persistent agency: long-lived Codex and Claude sessions that retain their own working context across phases. **That is not what ships today.** The current implementation is a deliberate degraded mode:

- every Codex call is a fresh, stateless `codex exec` invocation;
- every Claude call is a fresh `claude -p` one-shot invocation, through either the default print transport or the opt-in PTY transport;
- continuity comes entirely from artifacts Kairo re-feeds into each prompt.

This is honest and auditable, but it is not session persistence and should not be mistaken for it. The next major product upgrade is run observability/control; real persistent session support for both CLIs remains a later-stage project.

## Claude transports: print (default) and opt-in PTY

The default transport invokes `claude -p` (non-interactive print mode) via a plain subprocess. The opt-in PTY transport (`claude.transport: "pty"`) runs the **same public print-mode command** inside a real pseudo-terminal and streams output to the transcript file as it arrives. Honest scope of both:

- **Permission prompts cannot be answered mid-run on either transport.** The configured `permissionMode` (default `auto` → Claude's `acceptEdits`) decides up front what Claude may do; operations outside that mode are refused by Claude, not prompted. The PTY transport does NOT change this — Kairo does not attempt to recognize or answer arbitrary permission prompts.
- **No persistent Claude sessions and no live message injection** — on either transport. PTY is a transport foundation for those future stages, nothing more.
- Print mode buffers output and writes the transcript at the end; PTY mode streams chunks to `claude-transcript.log` while running.
- PTY caveats, accepted and documented (validated against Claude Code 2.1.167): `claude --print` refuses to read prompts from a TTY stdin, so the PTY transport passes the prompt as an argv element — prompts beyond ~180KB are rejected with guidance to use print mode (OS argv limits). Claude emits terminal mode-reset/ANSI sequences around its output; the raw transcript preserves them, while the text used for `claude-report.md` and review prompts is sanitized of escapes/control bytes.
- If `node-pty` (optional dependency) is missing and transport is `"pty"`, the invocation fails with a clear message telling you to install it or switch back to `"print"`. There is no silent fallback by design.

## No CLI session resume; context is reconstructed from artifacts

Persistent session resume in the Codex and Claude CLIs is version-dependent and was judged unreliable to build on. Kairo instead reconstructs context for every Codex call from artifacts (repo scan, master plan, implementer report, diff, check results). This is robust and auditable but:

- Long tasks pay a token cost re-sending context each call.
- Codex does not retain its own chain-of-thought between calls; only what landed in artifacts carries forward.

Session metadata files (`codex-session.json`, `claude-session.json`) exist for inspection but are not used for resume.

## Resumability is checkpoint-based, not live

`kairo resume` and `kairo ask` continue tasks paused at `awaiting_plan_approval` or `awaiting_user_decision`. What they are NOT:

- **No live message injection.** You cannot send direction to a Codex or Claude call that is actively running; messages only apply at persisted checkpoints.
- **No model-session resume.** Continuation context is reconstructed from artifacts (master plan, phase folders, diffs, check results) — see the degraded-session section above. Phase reconstruction tolerates missing artifacts with visible placeholders.
- Tasks paused **before** resumability existed have no `pending` metadata in task.json and cannot be resumed; start a new run.
- A crashed run (state `implementing`, `reviewing`, …) is not a checkpoint and is not resumable; only deliberate pauses are.

## Git repo with a clean working tree is mandatory

`kairo run` blocks before any model call if the directory is not a git repository or the working tree is dirty. This is by design: every diff Kairo captures must belong to the task. The cost is that you cannot run Kairo on top of in-progress local changes — commit or stash first. There is currently no override flag. If diff capture somehow fails *after* implementation (e.g. git breaks mid-run), the report flags it as a high risk and the commit recommendation becomes `not safe to commit`.

## `run_checks` / `review_diff` directives are shallow

The loop always captures a diff and runs checks after every implementation step, so these two directive actions are mostly redundant. If Codex emits one mid-loop, Kairo re-runs the checks for the current phase and routes the results back through a Codex review for a real decision — it is not a free-form tool call. Emitting either before any implementation phase ends the run as `blocked`.

## The safety blocklist is a regex gate, not a sandbox

`src/core/safety.ts` blocks known-destructive command shapes conservatively (it will even block dangerous text inside quoted strings). It is a last line of defense for Kairo-owned commands, not a security boundary:

- Codex-side commands rely on Codex's own sandbox (`workspace-write`).
- Claude-side commands rely on Claude Code's permission system.
- A sufficiently creative command could evade a regex. Do not point Kairo at a repo you cannot afford to restore from git.

## Check semantics are heuristic at the edges

A check is marked `skipped` when its binary is missing or the package manager reports a missing script (detected by matching known error strings from pnpm/npm). An unusual package manager error message could be misclassified as a failure. The full output tail is always saved in `checks.log` so misclassification is visible.

## Codex self-edit verification is diff-based

Codex self-edits run as a dedicated write-enabled `codex exec` session (planning calls are read-only), and the final message is captured to `codex-self-edit-transcript.md`. Kairo verifies the result by diff + checks + review and fails the run if the session produced no working-tree changes — but it cannot see *inside* the session beyond Codex's own sandbox and final message.

## Single working tree, single task at a time

Running two `kairo run` commands concurrently in the same repo will interleave diffs and check results. There is no locking. Run one task at a time.
