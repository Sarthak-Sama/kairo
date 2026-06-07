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

  it('defaults claude.transport to "print"', () => {
    expect(ConfigSchema.parse({ version: 1 }).claude.transport).toBe('print');
    expect(DEFAULT_CONFIG.claude.transport).toBe('print');
  });

  it('accepts explicit claude.transport "pty"', () => {
    const parsed = ConfigSchema.parse({ version: 1, claude: { transport: 'pty' } });
    expect(parsed.claude.transport).toBe('pty');
  });

  it('rejects unknown claude transports', () => {
    const result = ConfigSchema.safeParse({ version: 1, claude: { transport: 'websocket' } });
    expect(result.success).toBe(false);
  });

  it('defaults roles to the original team (codex head, claude development lead)', () => {
    const parsed = ConfigSchema.parse({ version: 1 });
    expect(parsed.roles.head).toBe('codex');
    expect(parsed.roles.developmentLead).toBe('claude');
    expect(DEFAULT_CONFIG.roles).toEqual({ head: 'codex', developmentLead: 'claude' });
  });

  it('accepts all four role combinations', () => {
    for (const head of ['codex', 'claude'] as const) {
      for (const developmentLead of ['codex', 'claude'] as const) {
        const parsed = ConfigSchema.parse({ version: 1, roles: { head, developmentLead } });
        expect(parsed.roles).toEqual({ head, developmentLead });
      }
    }
  });

  it('rejects invalid role providers', () => {
    expect(ConfigSchema.safeParse({ version: 1, roles: { head: 'gemini' } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ version: 1, roles: { developmentLead: 'gpt' } }).success).toBe(false);
  });

  it('defaults claude.headPermissionMode to "plan"', () => {
    expect(ConfigSchema.parse({ version: 1 }).claude.headPermissionMode).toBe('plan');
    expect(DEFAULT_CONFIG.claude.headPermissionMode).toBe('plan');
  });

  it('rejects checks with empty command', () => {
    const result = ConfigSchema.safeParse({
      version: 1,
      checks: [{ name: 'x', command: '' }],
    });
    expect(result.success).toBe(false);
  });
});
