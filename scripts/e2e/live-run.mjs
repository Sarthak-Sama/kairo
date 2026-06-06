#!/usr/bin/env node
/**
 * Drive a REAL `kairo run` (live Codex + Claude) through a PTY so the plan
 * approval gate can be auto-answered. Streams the live timeline to stdout.
 *
 * Usage: node scripts/e2e/live-run.mjs <sandbox-dir> "<task>" [answerForAskUser]
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pty = require('node-pty');

const KAIRO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(KAIRO_ROOT, 'dist', 'cli.js');
const [sandbox, task, askAnswer] = process.argv.slice(2);
if (!sandbox || !task) {
  console.error('usage: live-run.mjs <sandbox-dir> "<task>" [answerForAskUser]');
  process.exit(2);
}

const TIMEOUT_MS = 15 * 60 * 1000;
const proc = pty.spawn(process.execPath, [CLI, 'run', task], {
  cwd: sandbox,
  env: process.env,
  cols: 140,
  rows: 50,
});

let buf = '';
const timer = setTimeout(() => {
  console.error('\n[live-run] TIMEOUT after 15min — killing');
  proc.kill();
}, TIMEOUT_MS);

proc.onData((d) => {
  process.stdout.write(d);
  buf += d;
  if (buf.includes('approve plan?')) {
    buf = '';
    proc.write('y\r');
    process.stdout.write('\n[live-run] auto-approved plan\n');
  } else if (buf.includes('needs your decision') && buf.includes('> ')) {
    buf = '';
    const answer = askAnswer ?? 'Use your best judgment; keep it minimal.';
    proc.write(answer + '\r');
    process.stdout.write(`\n[live-run] auto-answered: ${answer}\n`);
  }
});

proc.onExit(({ exitCode }) => {
  clearTimeout(timer);
  console.log(`\n[live-run] kairo exited ${exitCode}`);
  process.exit(exitCode);
});
