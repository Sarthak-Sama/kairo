/**
 * Safety gate for commands Kairo itself runs (checks, codex-suggested commands).
 * Claude's own permission system covers Claude-side commands; this guards the
 * Kairo-owned execution paths.
 *
 * Kairo never auto-commits and never runs destructive commands.
 */

export interface SafetyVerdict {
  allowed: boolean;
  matchedPattern?: string;
  reason?: string;
}

interface DestructivePattern {
  id: string;
  regex: RegExp;
  reason: string;
}

/**
 * Match a binary in command position: start of string or after ;|&, optionally
 * preceded by env-var assignments (FOO=1), `env`, `command`, `exec`, `nohup`,
 * `time`, or `xargs` — the common prefixes used to launder a command name.
 */
function makeCommandPositionRegex(binary: string): RegExp {
  const prefix = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+|env\s+|command\s+|exec\s+|nohup\s+|time\s+|xargs\s+)*`;
  return new RegExp(String.raw`(?:^|[;|&]\s*)\s*${prefix}${binary}\b`);
}

const DESTRUCTIVE_PATTERNS: DestructivePattern[] = [
  {
    id: 'git-reset-hard',
    regex: /\bgit\s+(?:\S+\s+)*reset\b[^;|&\n]*--hard\b/,
    reason: 'git reset --hard discards uncommitted work',
  },
  {
    id: 'git-clean',
    regex: /\bgit\s+(?:\S+\s+)*clean\b/,
    reason: 'git clean deletes untracked files',
  },
  {
    id: 'git-push-force',
    regex: /\bgit\s+(?:\S+\s+)*push\b[^;|&\n]*(?:--force\b|--force-with-lease\b|\s-f\b)/,
    reason: 'force push rewrites remote history',
  },
  {
    // Matches recursive+force in any arrangement: -rf, -Rf, -fR, -r -f,
    // --recursive --force, etc. Flags may be split across tokens.
    id: 'rm-rf',
    regex: /\brm\b(?=[^;|&\n]*(?:-[a-zA-Z]*[rR]|--recursive\b))(?=[^;|&\n]*(?:-[a-zA-Z]*f|--force\b))/,
    reason: 'rm -rf recursively force-deletes files',
  },
  {
    id: 'sudo',
    regex: makeCommandPositionRegex('sudo'),
    reason: 'sudo escalates privileges',
  },
  {
    id: 'chmod-recursive',
    regex: /\bchmod\b[^;|&\n]*(?:-[a-zA-Z]*R[a-zA-Z]*\b|--recursive\b)/,
    reason: 'recursive chmod can break the system or repo permissions',
  },
  {
    id: 'chown-recursive',
    regex: /\bchown\b[^;|&\n]*(?:-[a-zA-Z]*R[a-zA-Z]*\b|--recursive\b)/,
    reason: 'recursive chown can break ownership across the filesystem',
  },
  {
    id: 'dd',
    regex: makeCommandPositionRegex('dd'),
    reason: 'dd writes raw data to devices/files',
  },
  {
    id: 'mkfs',
    regex: /\bmkfs(?:\.\w+)?\b/,
    reason: 'mkfs formats filesystems',
  },
  {
    id: 'git-commit',
    regex: /\bgit\s+(?:\S+\s+)*commit\b/,
    reason: 'Kairo never auto-commits; committing is a user decision',
  },
];

/** Check a single shell command string against the destructive-pattern blocklist. */
export function checkCommandSafety(command: string): SafetyVerdict {
  const normalized = command.trim();
  if (normalized.length === 0) {
    return { allowed: false, reason: 'empty command' };
  }
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.regex.test(normalized)) {
      return { allowed: false, matchedPattern: pattern.id, reason: pattern.reason };
    }
  }
  return { allowed: true };
}

export function assertCommandSafe(command: string): void {
  const verdict = checkCommandSafety(command);
  if (!verdict.allowed) {
    throw new UnsafeCommandError(command, verdict);
  }
}

export class UnsafeCommandError extends Error {
  constructor(
    public readonly command: string,
    public readonly verdict: SafetyVerdict,
  ) {
    super(
      `Blocked unsafe command: "${command}" (${verdict.matchedPattern ?? 'unknown'}: ${verdict.reason ?? 'no reason'})`,
    );
  }
}
