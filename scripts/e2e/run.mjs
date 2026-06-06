#!/usr/bin/env node
/**
 * Kairo stub-CLI end-to-end harness.
 *
 * Runs the REAL pipeline — built CLI, real adapters, real subprocesses, real
 * git, real checks — against stub `codex`/`claude` executables (scripts/e2e/bin)
 * that emit deterministic canned behavior per scenario.
 *
 * Usage:
 *   node scripts/e2e/run.mjs            # all scenarios
 *   node scripts/e2e/run.mjs happy_delegation self_edit
 *   KAIRO_E2E_KEEP=1 node scripts/e2e/run.mjs plan_pause   # keep sandboxes
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// pnpm extracts node-pty's prebuilt spawn-helper without the execute bit,
// which makes pty.spawn fail with "posix_spawnp failed" — self-heal it.
import { chmodSync, statSync } from 'node:fs';
import { execSync as _execSync } from 'node:child_process';
{
  const helpers = _execSync(
    'find node_modules/.pnpm -path "*node-pty*" -name spawn-helper 2>/dev/null || true',
    { cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), shell: '/bin/bash' },
  ).toString().trim().split('\n').filter(Boolean);
  for (const rel of helpers) {
    const abs = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', rel);
    if (!(statSync(abs).mode & 0o111)) chmodSync(abs, 0o755);
  }
}

const pty = require('node-pty');

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const KAIRO_ROOT = resolve(E2E_DIR, '..', '..');
const CLI = join(KAIRO_ROOT, 'dist', 'cli.js');
const STUB_BIN = join(E2E_DIR, 'bin');
const KEEP = process.env.KAIRO_E2E_KEEP === '1';
const TIMEOUT_MS = 30_000;

if (!existsSync(CLI)) {
  console.error(`dist/cli.js not found — run \`pnpm build\` first (${CLI})`);
  process.exit(2);
}

// ---------------------------------------------------------------- sandbox --

function makeSandbox({ git = true, dirty = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kairo-e2e-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'e2e-sandbox', version: '0.0.0', scripts: { test: 'node check-test.js' } }, null, 2));
  writeFileSync(join(dir, 'src', 'app.js'), 'module.exports = () => 42;\n');
  writeFileSync(join(dir, 'README.md'), '# e2e sandbox\n');
  // No .gitignore on purpose: `kairo init` must keep the tree clean by using
  // .git/info/exclude (H-1 regression coverage at the E2E level).
  // The "test" check: fails once if the harness planted a flag in the state dir.
  writeFileSync(join(dir, 'check-test.js'), `const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.KAIRO_E2E_STATE_DIR;
const flag = dir ? path.join(dir, 'check-fail-once') : null;
if (flag && fs.existsSync(flag)) { fs.unlinkSync(flag); console.error('simulated check failure'); process.exit(1); }
console.log('check ok');
`);
  if (git) {
    execSync('git init -q && git config user.email e2e@kairo.test && git config user.name kairo-e2e && git add -A && git commit -qm baseline', { cwd: dir, shell: '/bin/bash' });
  }
  if (dirty) {
    writeFileSync(join(dir, 'src', 'wip.js'), '// uncommitted user work\n');
  }
  return dir;
}

function initKairo(sandbox, { claudeCommand = 'claude', codexCommand = 'codex', claudeTransport = 'print' } = {}) {
  execSync(`node ${JSON.stringify(CLI)} init`, { cwd: sandbox });
  const configPath = join(sandbox, '.kairo', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.checks = [{ name: 'test', command: 'node check-test.js' }];
  config.claude.command = claudeCommand;
  config.claude.transport = claudeTransport;
  config.codex.command = codexCommand;
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// -------------------------------------------------------------- run the CLI

function makeEnv(scenario, stateDir, { stubsOnPath = true } = {}) {
  return {
    ...process.env,
    KAIRO_E2E_SCENARIO: scenario,
    KAIRO_E2E_STATE_DIR: stateDir,
    PATH: stubsOnPath ? `${STUB_BIN}:${process.env.PATH}` : process.env.PATH,
  };
}

/**
 * Non-interactive run: stdin is not a TTY, so approval/questions pause.
 * Pass a string for `kairo run "<task>"` or an args array for any command
 * (e.g. ['ask', taskId, 'y']).
 */
function runPlain(sandbox, env, taskOrArgs) {
  const args = Array.isArray(taskOrArgs) ? taskOrArgs : ['run', taskOrArgs];
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: sandbox, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => { child.kill('SIGKILL'); out += '\n[harness] TIMEOUT'; }, TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); resolveRun({ code, out }); });
  });
}

/** Interactive run via a real PTY; answers fire when their marker appears. */
function runPty(sandbox, env, task, answers) {
  return new Promise((resolveRun) => {
    const proc = pty.spawn(process.execPath, [CLI, 'run', task], { cwd: sandbox, env, cols: 120, rows: 40 });
    let out = '';
    let sinceLastAnswer = '';
    let i = 0;
    const timer = setTimeout(() => { proc.kill(); out += '\n[harness] TIMEOUT'; }, TIMEOUT_MS);
    proc.onData((d) => {
      out += d;
      sinceLastAnswer += d;
      if (i < answers.length && sinceLastAnswer.includes(answers[i].when)) {
        proc.write(answers[i].send + '\r');
        sinceLastAnswer = '';
        i++;
      }
    });
    proc.onExit(({ exitCode }) => { clearTimeout(timer); resolveRun({ code: exitCode, out }); });
  });
}

// ------------------------------------------------------------- assertions --

function taskDir(sandbox) {
  const tasks = join(sandbox, '.kairo', 'tasks');
  const entries = existsSync(tasks) ? readdirSync(tasks) : [];
  if (entries.length !== 1) throw new Error(`expected exactly 1 task, found ${entries.length}`);
  return join(tasks, entries[0]);
}

function taskId(sandbox) {
  return readdirSync(join(sandbox, '.kairo', 'tasks'))[0];
}

function readTask(sandbox) {
  return JSON.parse(readFileSync(join(taskDir(sandbox), 'task.json'), 'utf8'));
}

function readCodexLog(stateDir) {
  const p = join(stateDir, 'codex-log.ndjson');
  return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
}

function invariants(sandbox, failures, { expectTask = true, isGit = true } = {}) {
  // 1. Kairo never committed.
  if (isGit) {
    const commits = execSync('git rev-list --count HEAD', { cwd: sandbox }).toString().trim();
    if (commits !== '1') failures.push(`INVARIANT: expected 1 commit, found ${commits} — something committed!`);
  }
  if (!expectTask) return;
  const td = taskDir(sandbox);
  // 2. task.json coherent, ends in terminal/paused state.
  const task = readTask(sandbox);
  const okStates = ['reported', 'completed', 'blocked', 'failed', 'awaiting_plan_approval', 'awaiting_user_decision'];
  if (!okStates.includes(task.state)) failures.push(`INVARIANT: task ended in unexpected state ${task.state}`);
  if (task.stateHistory[0]?.state !== 'created') failures.push('INVARIANT: state history does not start at created');
  // 3. every NDJSON line parses.
  const log = readFileSync(join(td, 'agency-log.ndjson'), 'utf8').trim().split('\n');
  for (const [n, line] of log.entries()) {
    try { JSON.parse(line); } catch { failures.push(`INVARIANT: agency-log line ${n + 1} is not valid JSON`); }
  }
  // 4. report exists for every finished run.
  if (!existsSync(join(td, 'report.md'))) failures.push('INVARIANT: report.md missing');
}

const has = (sandbox, rel) => existsSync(join(taskDir(sandbox), rel));
const readArtifact = (sandbox, rel) => readFileSync(join(taskDir(sandbox), rel), 'utf8');

// -------------------------------------------------------------- scenarios --

const SCENARIOS = {
  // ---- Level 1: preflight / availability (no model CLI should be touched) --
  async preflight_nongit(check) {
    const sandbox = makeSandbox({ git: false });
    const stateDir = mkdtempSync(join(tmpdir(), 'kairo-e2e-state-'));
    initKairo(sandbox);
    const { code, out } = await runPlain(sandbox, makeEnv('happy_delegation', stateDir), 'Build something');
    check(code === 1, `exit code 1 (got ${code})`);
    check(out.includes('not a git repository'), 'message names git requirement');
    check(readCodexLog(stateDir).length === 0, 'stub codex never invoked');
    check(readTask(sandbox).state === 'blocked', 'task blocked');
    check(readArtifact(sandbox, 'report.md').includes('not safe to commit'), 'report not safe');
    return { sandbox, stateDir, expectTask: true, nonGit: true };
  },

  async preflight_dirty(check) {
    const sandbox = makeSandbox({ dirty: true });
    const stateDir = mkdtempSync(join(tmpdir(), 'kairo-e2e-state-'));
    initKairo(sandbox);
    const { code, out } = await runPlain(sandbox, makeEnv('happy_delegation', stateDir), 'Build something');
    check(code === 1, `exit code 1 (got ${code})`);
    check(/commit or stash/i.test(out), 'message says commit or stash');
    check(readCodexLog(stateDir).length === 0, 'stub codex never invoked');
    check(!execSync('git stash list', { cwd: sandbox }).toString().trim(), 'nothing was stashed');
    return { sandbox, stateDir, expectTask: true, allowDirty: true };
  },

  async missing_codex(check) {
    const sandbox = makeSandbox();
    const stateDir = mkdtempSync(join(tmpdir(), 'kairo-e2e-state-'));
    // Simulate a missing Codex CLI via config (PATH-independent).
    initKairo(sandbox, { codexCommand: 'definitely-missing-codex-xyz' });
    const { code, out } = await runPlain(sandbox, makeEnv('happy_delegation', stateDir, { stubsOnPath: false }), 'Build something');
    check(code === 1, `exit code 1 (got ${code})`);
    check(out.includes('Codex CLI'), 'error names the Codex CLI');
    check(out.includes('codex.command'), 'error points at codex.command config');
    return { sandbox, stateDir, expectTask: false, nonGitInvariantOnly: false };
  },

  // ---- Level 2: full pipeline through stubs ------------------------------
  async happy_delegation(check) {
    const sandbox = makeSandbox();
    const stateDir = mkdtempSync(join(tmpdir(), 'kairo-e2e-state-'));
    initKairo(sandbox);
    const { code, out } = await runPty(sandbox, makeEnv('happy_delegation', stateDir), 'Add a greeting feature', [
      { when: 'approve plan?', send: 'y' },
    ]);
    check(code === 0, `exit code 0 (got ${code})`);
    const task = readTask(sandbox);
    check(task.state === 'reported' && task.outcome === 'completed', `task reported/completed (got ${task.state}/${task.outcome})`);
    for (const artifact of [
      'repo-scan.md', 'master-plan.md', 'report.md',
      'phase-001/codex-directive.json', 'phase-001/claude-prompt.md', 'phase-001/claude-transcript.log',
      'phase-001/claude-report.md', 'phase-001/diff.patch', 'phase-001/checks.json', 'phase-001/checks.log',
      'phase-001/codex-review.md', 'phase-001/codex-decision.json',
    ]) check(has(sandbox, artifact), `artifact ${artifact}`);
    check(readArtifact(sandbox, 'phase-001/diff.patch').includes('feature.txt'), 'diff contains the real edit');
    const report = readArtifact(sandbox, 'report.md');
    check(report.includes('**safe to commit**'), 'report safe to commit');
    check(report.includes('clean working tree'), 'report notes clean baseline');
    check(out.includes('[claude]'), 'timeline shows claude activity');
    const sandboxes = readCodexLog(stateDir).map((e) => `${e.promptType}:${e.sandbox}`);
    check(JSON.stringify(sandboxes) === JSON.stringify(['triage:read-only', 'review:read-only']), `codex sandboxes ${sandboxes}`);
    return { sandbox, stateDir };
  },

  async self_edit(check) {
    const sandbox = makeSandbox();
    const stateDir = mkdtempSync(join(tmpdir(), 'kairo-e2e-state-'));
    initKairo(sandbox);
    // Quick low-risk self-edit bypasses approval -> works non-interactively.
    const { code } = await runPlain(sandbox, makeEnv('self_edit', stateDir), 'Append changelog line');
    check(code === 0, `exit code 0 (got ${code})`);
    check(readTask(sandbox).outcome === 'completed', 'completed');
    check(has(sandbox, 'phase-001/codex-self-edit-prompt.md'), 'self-edit prompt artifact');
    check(has(sandbox, 'phase-001/codex-self-edit-transcript.md'), 'self-edit transcript artifact');
    check(readArtifact(sandbox, 'phase-001/diff.patch').includes('changelog'), 'diff shows the self-edit');
    const sandboxes = readCodexLog(stateDir).map((e) => `${e.promptType}:${e.sandbox}`);
    check(
      JSON.stringify(sandboxes) === JSON.stringify(['triage:read-only', 'self-edit:workspace-write', 'review:read-only']),
      `sandbox discipline (got ${sandboxes})`,
    );
    check(!existsSync(join(stateDir, 'claude-log.ndjson')), 'claude never invoked');
    return { sandbox, stateDir };
  },

  async pty_delegation(check) {
    // Same happy delegation, but Claude runs through the opt-in PTY transport.
    const sandbox = makeSandbox();
    const stateDir = mkdtempSync(join(tmpdir(), 'kairo-e2e-state-'));
    // PTY spawn does not do PATH lookup through our injected env reliably —
    // point the config at the stub binary by absolute path.
    initKairo(sandbox, { claudeCommand: join(STUB_BIN, 'claude'), claudeTransport: 'pty' });
    const { code } = await runPty(sandbox, makeEnv('happy_delegation', stateDir), 'Add a greeting feature', [
      { when: 'approve plan?', send: 'y' },
    ]);
    check(code === 0, `exit code 0 (got ${code})`);
    const task = JSON.parse(readFileSync(join(taskDir(sandbox), 'task.json'), 'utf8'));
    check(task.outcome === 'completed', `completed via pty transport (got ${task.outcome})`);
    const transcript = readArtifact(sandbox, 'phase-001/claude-transcript.log');
    check(transcript.includes('Working on phase 1'), 'streamed transcript captured stub output');
    check(readArtifact(sandbox, 'phase-001/diff.patch').includes('feature.txt'), 'real edit captured');
    return { sandbox, stateDir };
  },

  async failed_check_revision(check) {
    const sandbox = makeSandbox();
    const stateDir = mkdtempSync(join(tmpdir(), 'kairo-e2e-state-'));
    initKairo(sandbox);
    writeFileSync(join(stateDir, 'check-fail-once'), '1'); // first check run fails
    const { code } = await runPty(sandbox, makeEnv('failed_check_revision', stateDir), 'Add a greeting feature', [
      { when: 'approve plan?', send: 'y' },
    ]);
    check(code === 0, `exit code 0 (got ${code})`);
    check(readTask(sandbox).outcome === 'completed', 'completed after revision');
    const claudeLog = readFileSync(join(stateDir, 'claude-log.ndjson'), 'utf8').trim().split('\n');
    check(claudeLog.length === 2, `claude invoked twice (got ${claudeLog.length})`);
    check(JSON.parse(claudeLog[1]).isRevision === true, 'second invocation was a revision');
    const events = readArtifact(sandbox, 'agency-log.ndjson');
    check(events.includes('"action":"run_checks","status":"failed"'), 'failed check visible in event log');
    return { sandbox, stateDir };
  },

  async plan_feedback(check) {
    const sandbox = makeSandbox();
    const stateDir = mkdtempSync(join(tmpdir(), 'kairo-e2e-state-'));
    initKairo(sandbox);
    const { code } = await runPty(sandbox, makeEnv('plan_feedback', stateDir), 'Add a greeting feature', [
      { when: 'approve plan?', send: 'Make the scope smaller please.' },
      { when: 'approve plan?', send: 'y' },
    ]);
    check(code === 0, `exit code 0 (got ${code})`);
    check(readTask(sandbox).outcome === 'completed', 'completed');
    check(readCodexLog(stateDir).some((e) => e.promptType === 'plan-feedback'), 'codex got a plan-feedback call');
    check(readArtifact(sandbox, 'master-plan.md').includes('Revised Plan'), 'master plan was revised');
    check(readArtifact(sandbox, 'phase-001/claude-prompt.md').includes('SHORTER'), 'claude got the revised instructions');
    check(readArtifact(sandbox, 'user-decisions.md').includes('Make the scope smaller'), 'feedback recorded');
    return { sandbox, stateDir };
  },

  async plan_pause(check) {
    const sandbox = makeSandbox();
    const stateDir = mkdtempSync(join(tmpdir(), 'kairo-e2e-state-'));
    initKairo(sandbox);
    const { code } = await runPlain(sandbox, makeEnv('plan_pause', stateDir), 'Add a greeting feature');
    check(code === 0, `exit code 0 (got ${code})`);
    check(readTask(sandbox).state === 'awaiting_plan_approval', 'paused awaiting_plan_approval');
    check(!existsSync(join(stateDir, 'claude-log.ndjson')), 'claude never invoked');
    check(has(sandbox, 'report.md'), 'report written on pause');
    return { sandbox, stateDir };
  },

  async ask_user(check) {
    const sandbox = makeSandbox();
    const stateDir = mkdtempSync(join(tmpdir(), 'kairo-e2e-state-'));
    initKairo(sandbox);
    const { code, out } = await runPty(sandbox, makeEnv('ask_user', stateDir), 'Add a greeting feature', [
      { when: 'needs your decision', send: 'English please' },
      { when: 'approve plan?', send: 'y' },
    ]);
    check(code === 0, `exit code 0 (got ${code})`);
    check(out.includes('Greeting in English or French?'), 'question shown to user');
    check(readTask(sandbox).outcome === 'completed', 'completed');
    const decisions = readArtifact(sandbox, 'user-decisions.md');
    check(decisions.includes('Greeting in English or French?') && decisions.includes('English please'), 'Q&A recorded');
    return { sandbox, stateDir };
  },

  async ask_resume_plan(check) {
    // Pause at plan approval non-interactively, then continue via `kairo ask`.
    const sandbox = makeSandbox();
    const stateDir = mkdtempSync(join(tmpdir(), 'kairo-e2e-state-'));
    initKairo(sandbox);
    const env = makeEnv('plan_pause', stateDir);

    const first = await runPlain(sandbox, env, 'Add a greeting feature');
    check(first.code === 0, `run exits 0 while pausing (got ${first.code})`);
    let task = JSON.parse(readFileSync(join(taskDir(sandbox), 'task.json'), 'utf8'));
    check(task.state === 'awaiting_plan_approval', 'paused awaiting_plan_approval');
    check(task.pending?.kind === 'plan_approval', 'pending plan_approval persisted');

    const second = await runPlain(sandbox, env, ['ask', taskId(sandbox), 'y']);
    check(second.code === 0, `ask exits 0 (got ${second.code})`);
    task = JSON.parse(readFileSync(join(taskDir(sandbox), 'task.json'), 'utf8'));
    check(task.state === 'reported' && task.outcome === 'completed', `completed after ask (got ${task.state}/${task.outcome})`);
    check(task.pending === null, 'pending cleared');
    check(has(sandbox, 'phase-001/claude-report.md'), 'claude implemented after approval');
    check(existsSync(join(taskDir(sandbox), 'user-messages.ndjson')), 'user message recorded');
    return { sandbox, stateDir };
  },

  async ask_resume_decision(check) {
    // Pause at a codex question, answer via ask, approve the resulting plan via a second ask.
    const sandbox = makeSandbox();
    const stateDir = mkdtempSync(join(tmpdir(), 'kairo-e2e-state-'));
    initKairo(sandbox);
    const env = makeEnv('ask_user', stateDir);

    const first = await runPlain(sandbox, env, 'Add a greeting feature');
    check(first.code === 0, `run exits 0 while pausing (got ${first.code})`);
    let task = JSON.parse(readFileSync(join(taskDir(sandbox), 'task.json'), 'utf8'));
    check(task.pending?.kind === 'user_decision', 'pending user_decision persisted');
    check(task.pending?.question?.includes('English or French'), 'pending stores the question');

    const second = await runPlain(sandbox, env, ['ask', taskId(sandbox), 'English please']);
    check(second.code === 0, `first ask exits 0 (got ${second.code})`);
    task = JSON.parse(readFileSync(join(taskDir(sandbox), 'task.json'), 'utf8'));
    // The post-decision delegation hits the plan gate; non-interactive ask pauses again.
    check(task.state === 'awaiting_plan_approval', `re-paused at plan gate (got ${task.state})`);
    check(task.pending?.kind === 'plan_approval', 'new pending plan_approval persisted');

    const third = await runPlain(sandbox, env, ['ask', taskId(sandbox), 'approve']);
    check(third.code === 0, `second ask exits 0 (got ${third.code})`);
    task = JSON.parse(readFileSync(join(taskDir(sandbox), 'task.json'), 'utf8'));
    check(task.state === 'reported' && task.outcome === 'completed', `completed (got ${task.state}/${task.outcome})`);
    const decisions = readArtifact(sandbox, 'user-decisions.md');
    check(decisions.includes('English please'), 'answer recorded in user-decisions.md');
    return { sandbox, stateDir };
  },

  async stop_blocked(check) {
    const sandbox = makeSandbox();
    const stateDir = mkdtempSync(join(tmpdir(), 'kairo-e2e-state-'));
    initKairo(sandbox);
    const { code } = await runPlain(sandbox, makeEnv('stop_blocked', stateDir), 'Impossible task');
    check(code === 1, `exit code 1 (got ${code})`);
    check(readTask(sandbox).outcome === 'blocked', 'blocked');
    check(readArtifact(sandbox, 'report.md').includes('not safe to commit'), 'report not safe');
    return { sandbox, stateDir };
  },

  async stop_unsafe(check) {
    const sandbox = makeSandbox();
    const stateDir = mkdtempSync(join(tmpdir(), 'kairo-e2e-state-'));
    initKairo(sandbox);
    const { code } = await runPlain(sandbox, makeEnv('stop_unsafe', stateDir), 'Delete production data');
    check(code === 1, `exit code 1 (got ${code})`);
    check(readTask(sandbox).outcome === 'unsafe', 'outcome unsafe');
    return { sandbox, stateDir };
  },

  async invalid_directive(check) {
    const sandbox = makeSandbox();
    const stateDir = mkdtempSync(join(tmpdir(), 'kairo-e2e-state-'));
    initKairo(sandbox);
    const { code } = await runPlain(sandbox, makeEnv('invalid_directive', stateDir), 'Do something');
    check(code === 1, `exit code 1 (got ${code})`);
    check(readTask(sandbox).outcome === 'failed', 'failed');
    check(has(sandbox, 'codex-triage-raw.txt'), 'raw codex output saved');
    return { sandbox, stateDir };
  },

  async claude_missing(check) {
    const sandbox = makeSandbox();
    const stateDir = mkdtempSync(join(tmpdir(), 'kairo-e2e-state-'));
    initKairo(sandbox, { claudeCommand: 'definitely-missing-claude-xyz' });
    const { code } = await runPty(sandbox, makeEnv('claude_missing', stateDir), 'Add a greeting feature', [
      { when: 'approve plan?', send: 'y' },
    ]);
    check(code === 1, `exit code 1 (got ${code})`);
    check(readTask(sandbox).outcome === 'failed', 'failed');
    check(readArtifact(sandbox, 'report.md').includes('required for delegated implementation'), 'report explains Claude requirement');
    return { sandbox, stateDir };
  },

  async self_edit_nodiff(check) {
    const sandbox = makeSandbox();
    const stateDir = mkdtempSync(join(tmpdir(), 'kairo-e2e-state-'));
    initKairo(sandbox);
    const { code } = await runPlain(sandbox, makeEnv('self_edit_nodiff', stateDir), 'Append changelog line');
    check(code === 1, `exit code 1 (got ${code})`);
    check(readTask(sandbox).outcome === 'failed', 'failed');
    check(readArtifact(sandbox, 'report.md').includes('no working-tree changes'), 'report explains empty self-edit');
    return { sandbox, stateDir };
  },
};

// ------------------------------------------------------------------ main --

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : Object.keys(SCENARIOS);
let failedScenarios = 0;

for (const name of names) {
  const fn = SCENARIOS[name];
  if (!fn) { console.error(`unknown scenario: ${name}`); process.exit(2); }
  const failures = [];
  const check = (cond, label) => { if (!cond) failures.push(label); };
  let ctx;
  try {
    ctx = await fn(check);
    if (!ctx.allowDirty) invariants(ctx.sandbox, failures, { expectTask: ctx.expectTask !== false, isGit: ctx.nonGit !== true });
  } catch (err) {
    failures.push(`threw: ${err.message}`);
  }
  if (failures.length === 0) {
    console.log(`PASS  ${name}`);
  } else {
    failedScenarios++;
    console.log(`FAIL  ${name}`);
    for (const f of failures) console.log(`      - ${f}`);
    if (ctx) console.log(`      sandbox: ${ctx.sandbox}`);
  }
  if (ctx && !KEEP && failures.length === 0) {
    rmSync(ctx.sandbox, { recursive: true, force: true });
    rmSync(ctx.stateDir, { recursive: true, force: true });
  }
}

console.log(`\n${names.length - failedScenarios}/${names.length} scenarios passed`);
process.exit(failedScenarios > 0 ? 1 : 0);
