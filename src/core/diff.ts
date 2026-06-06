import type { ProcessRunner } from '../adapters/process-runner.js';
import { shellQuote } from '../utils/shell.js';

export interface GitBaseline {
  isGitRepo: boolean;
  headSha: string | null;
  branch: string | null;
  dirty: boolean | null;
}

export interface DiffCapture {
  available: boolean;
  patch: string;
  changedFiles: string[];
  note?: string;
}

/** Record where the repo stood before Kairo touched anything. */
export async function captureBaseline(runner: ProcessRunner, cwd: string): Promise<GitBaseline> {
  const inside = await runner.runShell('git rev-parse --is-inside-work-tree', {
    cwd,
    skipSafetyCheck: true,
  });
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
    return { isGitRepo: false, headSha: null, branch: null, dirty: null };
  }
  const head = await runner.runShell('git rev-parse HEAD', { cwd, skipSafetyCheck: true });
  const branch = await runner.runShell('git rev-parse --abbrev-ref HEAD', {
    cwd,
    skipSafetyCheck: true,
  });
  const status = await runner.runShell('git status --porcelain', { cwd, skipSafetyCheck: true });
  return {
    isGitRepo: true,
    headSha: head.exitCode === 0 ? head.stdout.trim() : null,
    branch: branch.exitCode === 0 ? branch.stdout.trim() : null,
    dirty: status.exitCode === 0 ? status.stdout.trim().length > 0 : null,
  };
}

/**
 * Capture the working-tree diff (including untracked files) as a patch.
 * Read-only: uses git diff / status only — never stages, commits, or resets.
 */
export async function captureDiff(runner: ProcessRunner, cwd: string): Promise<DiffCapture> {
  const inside = await runner.runShell('git rev-parse --is-inside-work-tree', {
    cwd,
    skipSafetyCheck: true,
  });
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
    return {
      available: false,
      patch: '',
      changedFiles: [],
      note: 'Not a git repository — diff capture unavailable. Changes were made but cannot be diffed.',
    };
  }

  const tracked = await runner.runShell('git diff HEAD', { cwd, skipSafetyCheck: true });
  const status = await runner.runShell('git status --porcelain', { cwd, skipSafetyCheck: true });

  const changedFiles: string[] = [];
  const untracked: string[] = [];
  for (const line of status.stdout.split('\n')) {
    if (!line.trim()) continue;
    const flags = line.slice(0, 2);
    let file = unquoteGitPath(line.slice(3).trim());
    if (!file) continue;
    // Rename lines look like `R  old -> new`; report the new path.
    if ((flags[0] === 'R' || flags[0] === 'C') && file.includes(' -> ')) {
      file = unquoteGitPath(file.split(' -> ')[1]!.trim());
    }
    changedFiles.push(file);
    if (flags === '??') untracked.push(file);
  }

  // Include untracked file contents via no-index diff so the patch is complete.
  let untrackedPatch = '';
  for (const file of untracked) {
    const d = await runner.runShell(`git diff --no-index -- /dev/null ${shellQuote(file)}`, {
      cwd,
      skipSafetyCheck: true,
    });
    // git diff --no-index exits 1 when files differ; that's the expected case.
    if (d.stdout.trim()) untrackedPatch += d.stdout + '\n';
  }

  return {
    available: true,
    patch: [tracked.stdout, untrackedPatch].filter((p) => p.trim()).join('\n'),
    changedFiles,
  };
}

/**
 * git status --porcelain C-quotes paths containing special characters
 * (e.g. `"with space.txt"`, `"caf\303\251.txt"`). Undo that quoting.
 */
export function unquoteGitPath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"') || path.length < 2) return path;
  const inner = path.slice(1, -1);
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch !== '\\') {
      bytes.push(...encoder.encode(ch));
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) break;
    if (next === '"' || next === '\\') {
      bytes.push(next.charCodeAt(0));
      i++;
    } else if (next === 'n') {
      bytes.push(0x0a);
      i++;
    } else if (next === 't') {
      bytes.push(0x09);
      i++;
    } else if (/[0-7]/.test(next)) {
      // Octal escape (1-3 digits) = one raw byte; multi-byte UTF-8 paths come
      // through as consecutive octal escapes, hence the byte-level decode.
      const octal = inner.slice(i + 1).match(/^[0-7]{1,3}/)![0];
      bytes.push(parseInt(octal, 8));
      i += octal.length;
    } else {
      bytes.push(...encoder.encode(next));
      i++;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
