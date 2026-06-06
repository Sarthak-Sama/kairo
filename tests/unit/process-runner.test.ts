import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ExecaProcessRunner } from '../../src/adapters/process-runner.js';
import { fileExists } from '../../src/utils/fs.js';

describe('ExecaProcessRunner.commandExists', () => {
  const runner = new ExecaProcessRunner();
  const cwd = tmpdir();

  it('finds real commands', async () => {
    expect(await runner.commandExists('git', cwd)).toBe(true);
  });

  it('reports missing commands as false', async () => {
    expect(await runner.commandExists('definitely-not-a-real-binary-xyz', cwd)).toBe(false);
  });

  it('does not execute shell syntax smuggled into the command name', async () => {
    const marker = join(tmpdir(), `kairo-injection-${randomBytes(6).toString('hex')}`);
    const hostile = `git; touch ${marker}`;
    const exists = await runner.commandExists(hostile, cwd);
    expect(exists).toBe(false); // quoted as a single (nonexistent) name
    expect(await fileExists(marker)).toBe(false); // and nothing was executed
  });

  it('does not expand substitutions in the command name', async () => {
    const marker = join(tmpdir(), `kairo-injection-${randomBytes(6).toString('hex')}`);
    const hostile = `$(touch ${marker})`;
    await runner.commandExists(hostile, cwd);
    expect(await fileExists(marker)).toBe(false);
  });
});
