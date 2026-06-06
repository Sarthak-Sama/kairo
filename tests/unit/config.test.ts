import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import {
  ConfigSchema,
  DEFAULT_CONFIG,
  loadConfig,
  writeDefaultConfig,
  ConfigError,
} from '../../src/core/config.js';
import { writeText } from '../../src/utils/fs.js';
import { makeTempDir, cleanupDir } from '../helpers/mocks.js';

describe('config', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await cleanupDir(dir);
  });

  it('default config validates against the schema', () => {
    expect(() => ConfigSchema.parse(DEFAULT_CONFIG)).not.toThrow();
  });

  it('round-trips: writeDefaultConfig then loadConfig', async () => {
    await writeDefaultConfig(dir);
    const config = await loadConfig(dir);
    expect(config.version).toBe(1);
    expect(config.limits.maxPhases).toBe(6);
    expect(config.checks.map((c) => c.name)).toEqual(['typecheck', 'lint', 'test', 'build']);
  });

  it('throws ConfigError with init guidance when config is missing', async () => {
    await expect(loadConfig(dir)).rejects.toThrow(/kairo init/);
  });

  it('throws ConfigError for invalid JSON', async () => {
    await writeText(join(dir, '.kairo', 'config.json'), '{ not json');
    await expect(loadConfig(dir)).rejects.toThrow(ConfigError);
    await expect(loadConfig(dir)).rejects.toThrow(/not valid JSON/);
  });

  it('throws ConfigError with field paths for schema violations', async () => {
    await writeText(
      join(dir, '.kairo', 'config.json'),
      JSON.stringify({ version: 2, limits: { maxPhases: -1 } }),
    );
    await expect(loadConfig(dir)).rejects.toThrow(/version/);
  });

  it('fills defaults for omitted sections', () => {
    const minimal = ConfigSchema.parse({ version: 1 });
    expect(minimal.codex.command).toBe('codex');
    expect(minimal.claude.model).toBe('sonnet');
    expect(minimal.limits.maxRevisionLoopsPerPhase).toBe(3);
  });

  it('rejects checks with empty command', () => {
    const result = ConfigSchema.safeParse({
      version: 1,
      checks: [{ name: 'x', command: '' }],
    });
    expect(result.success).toBe(false);
  });
});
