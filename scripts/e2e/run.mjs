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

function initKairo(sandbox, { claudeCommand = 'claude', codexCommand = 'codex', claudeTransport = 'print', roles = null } = {}) {
  execSync(`node ${JSON.stringify(CLI)} init`, { cwd: sandbox });
  const configPath = join(sandbox, '.kairo', 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.checks = [{ name: 'test', command: 'node check-test.js' }];
  config.claude.command = claudeCommand;
  config.claude.transport = claudeTransport;
  config.codex.command = codexCommand;
  if (roles) config.roles = roles;
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
    check(out.includes('head agent "codex"'), 'error names the head agent and provider');
    check(out.includes('definitely-missing-codex-xyz'), 'error shows the configured command');
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
      'phase-001/head-directive.json', 'phase-001/development-lead-prompt.md', 'phase-001/development-lead-transcript.log',
      'phase-001/development-lead-report.md', 'phase-001/diff.patch', 'phase-001/checks.json', 'phase-001/checks.log',
      'phase-001/head-review.md', 'phase-001/head-decision.json',
    ]) check(has(sandbox, artifact), `artifact ${artifact}`);
    check(readArtifact(sandbox, 'phase-001/diff.patch').includes('feature.txt'), 'diff contains the real edit');
    const report = readArtifact(sandbox, 'report.md');
    check(report.includes('**safe to commit**'), 'report safe to commit');
    check(report.includes('clean working tree'), 'report notes clean baseline');
    check(out.includes('[development:claude]'), 'timeline shows provider-labelled development activity');
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
    check(has(sandbox, 'phase-001/head-self-edit-prompt.md'), 'self-edit prompt artifact');
    check(has(sandbox, 'phase-001/head-self-edit-transcript.md'), 'self-edit transcript artifact');
    check(readArtifact(sandbox, 'phase-001/diff.patch').includes('changelog'), 'diff shows the self-edit');
    const sandboxes = readCodexLog(stateDir).map((e) => `${e.promptType}:${e.sandbox}`);
    check(
      JSON.stringify(sandboxes) === JSON.stringify(['triage:read-only', 'self-edit:workspace-write', 'review:read-only']),
      `sandbox discipline (got ${sandboxes})`,
    );
    check(!existsSync(join(stateDir, 'claude-log.ndjson')), 'claude never invoked');
    return { sandbox, stateDir };
  },

  async profile_run(check) {
    // User-defined profiles: --profile resolves the team, task.json records
    // it, the report carries the Operating Profile section, and `kairo
    // profiles` lists what is configured.
    const sandbox = makeSandbox();
    const stateDir = mkdtempSync(join(tmpdir(), 'kairo-e2e-state-'));
    initKairo(sandbox, { codexCommand: 'definitely-missing-codex-xyz' });
    const configPath = join(sandbox, '.kairo', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.profiles = {
      daily: { head: 'claude', developmentLead: 'claude' },
      'review-heavy': { head: 'codex', developmentLead: 'claude' },
    };
    config.defaultProfile = null;
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const env = makeEnv('happy_delegation', stateDir);

    // Unknown profile fails before any model call.
    const bad = await runPlain(sandbox, env, ['run', '--profile', 'nonexistent', 'Add a greeting feature']);
    check(bad.code === 1, `unknown profile exits 1 (got ${bad.code})`);
    check(bad.out.includes('unknown profile "nonexistent"'), 'unknown profile error is clear');
    check(!existsSync(join(stateDir, 'claude-log.ndjson')), 'no model call for unknown profile');

    // `kairo profiles` lists configured profiles.
    const list = await runPlain(sandbox, env, ['profiles']);
    check(list.out.includes('daily') && list.out.includes('head=claude'), 'profiles listed');
    check(list.out.includes('review-heavy') && list.out.includes('head=codex'), 'second profile listed');

    // Run with --profile daily (claude/claude): codex is absent and unneeded.
    const first = await runPlain(sandbox, env, ['run', '--profile', 'daily', 'Add a greeting feature']);
    check(first.code === 0, `run exits 0 (got ${first.code})`);
    let task = JSON.parse(readFileSync(join(taskDir(sandbox), 'task.json'), 'utf8'));
    check(task.profile === 'daily', `task stores profile (got ${task.profile})`);
    check(task.team?.head === 'claude' && task.team?.developmentLead === 'claude', 'task stores team');
    check(task.state === 'awaiting_plan_approval', 'paused at gate');

    // Resume via ask uses the STORED team (still no codex needed).
    const second = await runPlain(sandbox, env, ['ask', taskId(sandbox), 'y']);
    check(second.code === 0, `ask exits 0 (got ${second.code})`);
    task = JSON.parse(readFileSync(join(taskDir(sandbox), 'task.json'), 'utf8'));
    check(task.outcome === 'completed', `completed (got ${task.outcome})`);
    const report = readArtifact(sandbox, 'report.md');
    check(report.includes('## Operating Profile'), 'report has the section');
    check(report.includes('- Profile: daily'), 'report records the profile name');
    check(report.includes('- Development lead: claude'), 'report records the team');
    check(!existsSync(join(stateDir, 'codex-log.ndjson')), 'zero codex invocations across the whole flow');
    return { sandbox, stateDir };
  },

  async claude_head_team(check) {
    // Role-selectable team: Claude as head AND development lead. Codex is
    // deliberately absent (missing command) — the run must not need it.
    const sandbox = makeSandbox();
    const stateDir = mkdtempSync(join(tmpdir(), 'kairo-e2e-state-'));
    initKairo(sandbox, {
      codexCommand: 'definitely-missing-codex-xyz',
      roles: { head: 'claude', developmentLead: 'claude' },
    });
    const env = makeEnv('happy_delegation', stateDir);

    const first = await runPlain(sandbox, env, 'Add a greeting feature');
    check(first.code === 0, `run exits 0 while pausing (got ${first.code})`);
    let task = JSON.parse(readFileSync(join(taskDir(sandbox), 'task.json'), 'utf8'));
    check(task.state === 'awaiting_plan_approval', `paused at gate (got ${task.state})`);

    const second = await runPlain(sandbox, env, ['ask', taskId(sandbox), 'y']);
    check(second.code === 0, `ask exits 0 (got ${second.code})`);
    task = JSON.parse(readFileSync(join(taskDir(sandbox), 'task.json'), 'utf8'));
    check(task.state === 'reported' && task.outcome === 'completed', `completed (got ${task.state}/${task.outcome})`);

    // Codex was never touched; every call went to the claude stub.
    check(!existsSync(join(stateDir, 'codex-log.ndjson')), 'zero codex invocations');
    const claudeLog = readFileSync(join(stateDir, 'claude-log.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const roles = claudeLog.map((e) => e.role);
    check(roles.includes('head-triage') && roles.includes('head-review') && roles.includes('development'),
      `claude served all roles (got ${roles.join(',')})`);
    // Head calls use headPermissionMode "plan"; development uses acceptEdits.
    const headCall = claudeLog.find((e) => e.role === 'head-triage');
    const devCall = claudeLog.find((e) => e.role === 'development');
    check(headCall.argv.join(' ').includes('--permission-mode plan'), `head used plan mode (${headCall.argv.join(' ')})`);
    check(devCall.argv.join(' ').includes('--permission-mode acceptEdits'), 'development used acceptEdits');
    // Role-neutral artifacts and provider-labelled timeline.
    check(has(sandbox, 'phase-001/head-review.md'), 'head-review.md written');
    check(has(sandbox, 'phase-001/development-lead-report.md'), 'development-lead-report.md written');
    check(second.out.includes('[head:claude]'), 'timeline shows head:claude');
    check(second.out.includes('[development:claude]'), 'timeline shows development:claude');
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
    const transcript = readArtifact(sandbox, 'phase-001/development-lead-transcript.log');
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
    check(readArtifact(sandbox, 'phase-001/development-lead-prompt.md').includes('SHORTER'), 'claude got the revised instructions');
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
    check(has(sandbox, 'phase-001/development-lead-report.md'), 'claude implemented after approval');
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

  async tui_smoke(check) {
    // Operator console driven through a real PTY against a paused task:
    // render, note (n), approve (y), and verify the run completes.
    const sandbox = makeSandbox();
    const stateDir = mkdtempSync(join(tmpdir(), 'kairo-e2e-state-'));
    initKairo(sandbox, {
      codexCommand: 'definitely-missing-codex-xyz',
      roles: { head: 'claude', developmentLead: 'claude' },
    });
    const env = makeEnv('happy_delegation', stateDir);

    const first = await runPlain(sandbox, env, 'Add a greeting feature');
    check(first.code === 0, `run pauses at gate (got ${first.code})`);

    // Drive the TUI state-by-state: each step waits for its on-screen cue.
    const result = await new Promise((resolveTui) => {
      const proc = pty.spawn(process.execPath, [CLI, 'tui'], { cwd: sandbox, env, cols: 140, rows: 45 });
      let out = '';
      let step = 0;
      const timer = setTimeout(() => { proc.kill(); resolveTui({ out: out + '\n[harness] TIMEOUT', code: -1 }); }, 60_000);
      proc.onData((d) => {
        out += d;
        const clean = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
        if (step === 0 && clean.includes('Pending: approve plan')) {
          step = 1;
          setTimeout(() => proc.write('n'), 400); // open note input after a settled render
        } else if (step === 1 && clean.includes('note>')) {
          step = 2;
          // Return must be a separate write: inside one chunk it is treated
          // as pasted text, not as the submit key.
          setTimeout(() => proc.write('Reviewed via TUI smoke test.'), 200);
          setTimeout(() => proc.write('\r'), 500);
        } else if (step === 2 && clean.includes('note recorded')) {
          step = 3;
          setTimeout(() => proc.write('y'), 300); // approve
        } else if (step === 3 && clean.includes('task finished: completed')) {
          step = 4;
          setTimeout(() => proc.write('q'), 300);
        }
      });
      proc.onExit(({ exitCode }) => { clearTimeout(timer); resolveTui({ out, code: exitCode }); });
    });

    check(result.code === 0, `tui exits cleanly (got ${result.code})`);
    check(result.out.includes('Tasks (1)'), 'task list rendered');
    check(result.out.includes('Pending:'), 'pending block rendered');
    check(result.out.includes('approve plan (y)'), 'approval hint rendered');
    const task = JSON.parse(readFileSync(join(taskDir(sandbox), 'task.json'), 'utf8'));
    check(task.outcome === 'completed', `task completed via TUI approve (got ${task.outcome})`);
    check(readArtifact(sandbox, 'manager-notes.md').includes('Reviewed via TUI smoke test.'), 'note recorded via TUI');
    check(task.pending === null, 'pending cleared');
    return { sandbox, stateDir };
  },

  async cancel_inflight(check) {
    // True in-flight cancellation: the stub dev lead streams partial output
    // and hangs; `kairo stop` runs in parallel and the owned child must die.
    const sandbox = makeSandbox();
    const stateDir = mkdtempSync(join(tmpdir(), 'kairo-e2e-state-'));
    initKairo(sandbox, {
      codexCommand: 'definitely-missing-codex-xyz',
      roles: { head: 'claude', developmentLead: 'claude' },
    });
    const env = makeEnv('slow_dev', stateDir);

    // Head triage/review prompts get answered normally even in slow_dev (the
    // stub branches on role first), so run to the gate, approve, and the dev
    // phase will hang.
    const first = await runPlain(sandbox, env, 'Add a greeting feature');
    check(first.code === 0, `run pauses at gate (got ${first.code})`);

    // Approve in the background; while implementation hangs, stop the task.
    const askPromise = runPlain(sandbox, env, ['ask', taskId(sandbox), 'y']);
    const pidFile = join(stateDir, 'slow-dev-pid');
    const deadline = Date.now() + 15_000;
    while (!existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    check(existsSync(pidFile), 'slow dev process started');
    const devPid = Number(readFileSync(pidFile, 'utf8'));

    const stop = await runPlain(sandbox, env, ['stop', taskId(sandbox), '--reason', 'Testing in-flight cancellation.']);
    check(stop.code === 0, `stop exits 0 (got ${stop.code})`);
    check(stop.out.includes('cancelled at the next transport check'), 'stop is honest about cancellation timing');

    const ask = await askPromise; // the runner observes cancellation and finalizes
    // A user-requested stop is a fulfilled instruction, not a failure: exit 0
    // (matching `kairo stop` on paused tasks).
    check(ask.code === 0, `cancelled run exits 0 (got ${ask.code})`);
    check(ask.out.includes('stopped_by_user'), 'runner reports the stopped outcome');

    const task = JSON.parse(readFileSync(join(taskDir(sandbox), 'task.json'), 'utf8'));
    check(task.state === 'blocked' && task.outcome === 'stopped_by_user', `stopped (got ${task.state}/${task.outcome})`);
    const transcript = readArtifact(sandbox, 'phase-001/development-lead-transcript.log');
    check(transcript.includes('PARTIAL: started implementing'), 'partial transcript preserved');
    const report = readArtifact(sandbox, 'report.md');
    check(report.includes('cancelled mid-flight'), 'report flags mid-flight cancellation');
    check(report.includes('not safe to commit'), 'not safe to commit');
    // The owned child is actually dead.
    let alive = true;
    try {
      process.kill(devPid, 0);
    } catch {
      alive = false;
    }
    check(!alive, `slow dev child terminated (pid ${devPid})`);
    return { sandbox, stateDir };
  },

  async stop_and_note(check) {
    // Supervision control through the real CLI: note a paused task, stop it,
    // verify the terminal state and that resume refuses.
    const sandbox = makeSandbox();
    const stateDir = mkdtempSync(join(tmpdir(), 'kairo-e2e-state-'));
    initKairo(sandbox);
    const env = makeEnv('plan_pause', stateDir);

    const first = await runPlain(sandbox, env, 'Add a greeting feature');
    check(first.code === 0, `run exits 0 while pausing (got ${first.code})`);

    const id = taskId(sandbox);
    const note = await runPlain(sandbox, env, ['note', id, 'Reviewed the plan; postponing this work.']);
    check(note.code === 0, `note exits 0 (got ${note.code})`);
    check(note.out.includes('notes do not answer it'), 'note explains it does not answer the pending question');
    let task = JSON.parse(readFileSync(join(taskDir(sandbox), 'task.json'), 'utf8'));
    check(task.pending?.kind === 'plan_approval', 'note did not consume the pending checkpoint');

    const stop = await runPlain(sandbox, env, ['stop', id, '--reason', 'Operator decided not to proceed.']);
    check(stop.code === 0, `stop exits 0 (got ${stop.code})`);
    task = JSON.parse(readFileSync(join(taskDir(sandbox), 'task.json'), 'utf8'));
    check(task.state === 'blocked' && task.outcome === 'stopped_by_user', `terminal stopped state (got ${task.state}/${task.outcome})`);
    check(task.pending === null, 'pending cleared by stop');
    const report = readArtifact(sandbox, 'report.md');
    check(report.includes('Operator decided not to proceed.'), 'report carries the stop reason');
    check(report.includes('no commit needed'), 'no-work stop says no commit needed');

    const resume = await runPlain(sandbox, env, ['resume', id]);
    check(resume.code === 1, `resume refuses stopped task (got ${resume.code})`);
    check(resume.out.includes('terminal tasks cannot be resumed'), 'resume explains why');
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
    check(has(sandbox, 'head-triage-raw.txt'), 'raw codex output saved');
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
