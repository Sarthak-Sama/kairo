# Known Limitations

This is the honest list for the current version (0.1.0).

## This is a v0 degraded session mode

The intended product is a persistent agency: long-lived Codex and Claude sessions that retain their own working context across phases. **That is not what ships today.** The current implementation is a deliberate degraded mode:

- every Codex call is a fresh, stateless `codex exec` invocation;
- every Claude call is a fresh `claude -p` print-mode invocation;
- continuity comes entirely from artifacts Kairo re-feeds into each prompt.

This is honest and auditable, but it is not session persistence and should not be mistaken for it. The two next major upgrades are the `node-pty` interactive Claude adapter and real persistent session support for both CLIs.

## Claude integration runs in print mode, not a PTY

The Claude adapter invokes `claude -p` (non-interactive print mode) via a plain subprocess. Consequences:

- Claude's interactive permission prompts cannot be answered mid-run. The configured `permissionMode` (default `auto`, mapped to Claude's `acceptEdits`) decides up front what Claude may do. Operations outside that mode will be refused by Claude rather than prompted.
- The transcript is captured at the end of the invocation, not streamed live.

A `node-pty`-based interactive adapter is the planned upgrade. The adapter interface (`ClaudeAdapter`) is already in place so it can be swapped in without touching the orchestrator. `node-pty` is declared as an optional dependency for that reason.

## No CLI session resume; context is reconstructed from artifacts

Persistent session resume in the Codex and Claude CLIs is version-dependent and was judged unreliable to build on. Kairo instead reconstructs context for every Codex call from artifacts (repo scan, master plan, implementer report, diff, check results). This is robust and auditable but:

- Long tasks pay a token cost re-sending context each call.
- Codex does not retain its own chain-of-thought between calls; only what landed in artifacts carries forward.

Session metadata files (`codex-session.json`, `claude-session.json`) exist for inspection but are not used for resume.

## `kairo resume` and `kairo ask` are not implemented

A task that pauses as `awaiting_user_decision` in a non-interactive session cannot currently be continued in place. The question and full context are in the task folder (`user-decisions.md`, `agency-log.ndjson`); the workaround is to start a new run with the decision included in the task description. The state model and artifact layout were designed so resume can be added without migration.

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
