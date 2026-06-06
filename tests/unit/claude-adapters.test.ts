import { describe, it, expect } from 'vitest';
import { ConfigSchema } from '../../src/core/config.js';
import { ClaudeCliAdapter } from '../../src/adapters/claude.js';
import { ClaudePtyAdapter, type PtyModule, type PtyProcess } from '../../src/adapters/claude-pty.js';
import { createClaudeAdapter } from '../../src/adapters/claude-factory.js';
import { MockProcessRunner } from '../helpers/mocks.js';

const REPO = '/repo';

function makeConfig(transport: 'print' | 'pty') {
  return ConfigSchema.parse({ version: 1, claude: { transport } });
}

describe('claude adapter factory', () => {
  it('returns the print adapter for default config', () => {
    const adapter = createClaudeAdapter(new MockProcessRunner(), makeConfig('print'), REPO);
    expect(adapter).toBeInstanceOf(ClaudeCliAdapter);
  });

  it('returns the PTY adapter for transport: "pty"', () => {
    const adapter = createClaudeAdapter(new MockProcessRunner(), makeConfig('pty'), REPO);
    expect(adapter).toBeInstanceOf(ClaudePtyAdapter);
  });
});

/** Scriptable fake PTY process. */
class FakePtyProcess implements PtyProcess {
  written: string[] = [];
  killed = false;
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number }) => void) | null = null;

  onData(cb: (d: string) => void): void {
    this.dataCb = cb;
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitCb = cb;
  }
  write(d: string): void {
    this.written.push(d);
  }
  kill(): void {
    this.killed = true;
  }
  emitData(d: string): void {
    this.dataCb?.(d);
  }
  emitExit(exitCode: number): void {
    this.exitCb?.({ exitCode });
  }
}

function fakePtyModule(
  proc: FakePtyProcess,
  script?: (proc: FakePtyProcess) => void,
): PtyModule & { spawnedWith: { file: string; args: string[] } | null } {
  const mod = {
    spawnedWith: null as { file: string; args: string[] } | null,
    spawn: (file: string, args: string[]) => {
      mod.spawnedWith = { file, args };
      if (script) setTimeout(() => script(proc), 0);
      return proc;
    },
  };
  return mod;
}

describe('ClaudePtyAdapter', () => {
  it('fails clearly when node-pty cannot be loaded', async () => {
    const adapter = new ClaudePtyAdapter(
      new MockProcessRunner(),
      makeConfig('pty'),
      REPO,
      async () => {
        throw new Error('Cannot find module node-pty');
      },
    );
    const result = await adapter.invoke({ prompt: 'hello', purpose: 'test' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/node-pty could not be loaded/);
    expect(result.error).toMatch(/claude\.transport to "print"/);
  });

  it('streams chunks through onChunk and assembles the transcript', async () => {
    const proc = new FakePtyProcess();
    const mod = fakePtyModule(proc, (p) => {
      p.emitData('first chunk\n');
      p.emitData('second chunk\n');
      p.emitExit(0);
    });
    const adapter = new ClaudePtyAdapter(new MockProcessRunner(), makeConfig('pty'), REPO, async () => mod);
    const chunks: string[] = [];
    const result = await adapter.invoke({
      prompt: 'do the thing',
      purpose: 'test',
      onChunk: (c) => chunks.push(c),
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(chunks).toEqual(['first chunk\n', 'second chunk\n']);
    expect(result.transcript).toBe('first chunk\nsecond chunk\n');
    // Prompt travels as an argv element — `claude --print` refuses TTY stdin.
    expect(mod.spawnedWith?.args).toEqual(['-p', 'do the thing', '--permission-mode', 'acceptEdits', '--model', 'sonnet']);
    // Nothing is written to the PTY's stdin at all.
    expect(proc.written).toEqual([]);
  });

  it('rejects prompts too large for argv delivery with guidance to use print', async () => {
    const adapter = new ClaudePtyAdapter(
      new MockProcessRunner(),
      makeConfig('pty'),
      REPO,
      async () => fakePtyModule(new FakePtyProcess()),
    );
    const result = await adapter.invoke({ prompt: 'x'.repeat(200_000), purpose: 'test' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/too large/);
    expect(result.error).toMatch(/"print"/);
  });

  it('reports non-zero exits as failures with the exit code', async () => {
    const proc = new FakePtyProcess();
    const adapter = new ClaudePtyAdapter(
      new MockProcessRunner(),
      makeConfig('pty'),
      REPO,
      async () =>
        fakePtyModule(proc, (p) => {
          p.emitData('partial output');
          p.emitExit(3);
        }),
    );
    const result = await adapter.invoke({ prompt: 'x', purpose: 'test' });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.error).toMatch(/exited 3/);
    expect(result.transcript).toBe('partial output'); // partial output preserved
  });

  it('times out and kills the process, keeping partial transcript', async () => {
    const proc = new FakePtyProcess();
    const adapter = new ClaudePtyAdapter(
      new MockProcessRunner(),
      makeConfig('pty'),
      REPO,
      async () =>
        fakePtyModule(proc, (p) => {
          p.emitData('started but never finishes');
          // no exit
        }),
      50, // 50ms timeout for the test
    );
    const result = await adapter.invoke({ prompt: 'x', purpose: 'test' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/);
    expect(result.transcript).toBe('started but never finishes');
    expect(proc.killed).toBe(true);
  });

  it('ignores data arriving after settle (post-timeout buffered chunks)', async () => {
    const proc = new FakePtyProcess();
    const adapter = new ClaudePtyAdapter(
      new MockProcessRunner(),
      makeConfig('pty'),
      REPO,
      async () =>
        fakePtyModule(proc, (p) => {
          p.emitData('before timeout');
          // never exits -> timeout settles the result
        }),
      50,
    );
    const chunks: string[] = [];
    const result = await adapter.invoke({ prompt: 'x', purpose: 'test', onChunk: (c) => chunks.push(c) });
    expect(result.error).toMatch(/timed out/);
    // node-pty can flush buffered data between kill() and teardown — the
    // settled result and the caller's onChunk must not see it.
    proc.emitData('late buffered data');
    proc.emitExit(0);
    expect(chunks).toEqual(['before timeout']);
    expect(result.transcript).toBe('before timeout');
  });

  it('fails clearly when the PTY spawn itself throws', async () => {
    const adapter = new ClaudePtyAdapter(
      new MockProcessRunner(),
      makeConfig('pty'),
      REPO,
      async () => ({
        spawn: () => {
          throw new Error('posix_spawnp failed');
        },
      }),
    );
    const result = await adapter.invoke({ prompt: 'x', purpose: 'test' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/failed to spawn/);
  });

  it('isAvailable reflects the claude command, like the print adapter', async () => {
    const runner = new MockProcessRunner();
    const adapter = new ClaudePtyAdapter(runner, makeConfig('pty'), REPO);
    expect(await adapter.isAvailable()).toBe(true);
    runner.missingBinaries.add('claude');
    expect(await adapter.isAvailable()).toBe(false);
  });
});
