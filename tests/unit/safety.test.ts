import { describe, it, expect } from 'vitest';
import { checkCommandSafety, assertCommandSafe, UnsafeCommandError } from '../../src/core/safety.js';

describe('destructive command detection', () => {
  const blocked: Array<[string, string]> = [
    ['git reset --hard', 'git-reset-hard'],
    ['git reset --hard HEAD~3', 'git-reset-hard'],
    ['git clean -fd', 'git-clean'],
    ['git push --force origin main', 'git-push-force'],
    ['git push -f', 'git-push-force'],
    ['git push --force-with-lease', 'git-push-force'],
    ['rm -rf node_modules', 'rm-rf'],
    ['rm -fr /tmp/x', 'rm-rf'],
    ['sudo rm file', 'sudo'],
    ['sudo apt install thing', 'sudo'],
    ['chmod -R 777 .', 'chmod-recursive'],
    ['chown -R user:user /', 'chown-recursive'],
    ['dd if=/dev/zero of=/dev/sda', 'dd'],
    ['mkfs.ext4 /dev/sda1', 'mkfs'],
    ['git commit -m "auto"', 'git-commit'],
    ['echo hi && sudo reboot', 'sudo'],
    ['ls; git reset --hard', 'git-reset-hard'],
    // Bypass attempts found in review: flag-case, split flags, command prefixes
    ['rm -Rf /tmp/x', 'rm-rf'],
    ['rm -fR /tmp/x', 'rm-rf'],
    ['rm -r -f foo', 'rm-rf'],
    ['rm --recursive --force foo', 'rm-rf'],
    ['rm -f -r foo', 'rm-rf'],
    ['command sudo reboot', 'sudo'],
    ['env sudo reboot', 'sudo'],
    ['FOO=1 sudo reboot', 'sudo'],
    ['command dd if=/dev/zero of=/dev/sda', 'dd'],
    ['LANG=C dd if=/dev/zero of=/dev/sda', 'dd'],
    ['nohup sudo shutdown now', 'sudo'],
  ];

  it.each(blocked)('blocks: %s', (command, expectedPattern) => {
    const verdict = checkCommandSafety(command);
    expect(verdict.allowed).toBe(false);
    expect(verdict.matchedPattern).toBe(expectedPattern);
  });

  const allowed = [
    'git status',
    'git diff HEAD',
    'git log --oneline',
    'git push origin feature-branch',
    'git reset --soft HEAD~1',
    'rm file.txt',
    'rm -f file.txt', // force without recursive is allowed
    'ddgr search-term', // dd prefix of another binary
    'sudoku-solver run', // sudo prefix of another binary
    'pnpm test',
    'pnpm typecheck',
    'npx tsc --noEmit',
    'chmod 644 file.txt',
    'echo "git reset --hard is dangerous"', // inside quotes — regex is conservative; see note below
  ];

  // Note: the quoted-string case above is intentionally still BLOCKED by the
  // conservative matcher; we assert the conservative behavior explicitly.
  it.each(allowed.slice(0, -1))('allows: %s', (command) => {
    expect(checkCommandSafety(command).allowed).toBe(true);
  });

  it('is conservative: blocks dangerous text even inside quotes', () => {
    expect(checkCommandSafety('echo "git reset --hard is dangerous"').allowed).toBe(false);
  });

  it('blocks empty commands', () => {
    expect(checkCommandSafety('   ').allowed).toBe(false);
  });

  it('assertCommandSafe throws UnsafeCommandError with details', () => {
    try {
      assertCommandSafe('rm -rf /');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeCommandError);
      expect((err as UnsafeCommandError).verdict.matchedPattern).toBe('rm-rf');
    }
  });

  it('assertCommandSafe passes safe commands through', () => {
    expect(() => assertCommandSafe('pnpm build')).not.toThrow();
  });
});
