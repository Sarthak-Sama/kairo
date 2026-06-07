import { describe, it, expect } from 'vitest';
import { ConfigSchema, resolveTeam, ConfigError, DEFAULT_CONFIG } from '../../src/core/config.js';

describe('operating profiles config', () => {
  it('old minimal config validates with empty profiles and null defaultProfile', () => {
    const parsed = ConfigSchema.parse({ version: 1 });
    expect(parsed.profiles).toEqual({});
    expect(parsed.defaultProfile).toBeNull();
    expect(DEFAULT_CONFIG.profiles).toEqual({});
    expect(DEFAULT_CONFIG.defaultProfile).toBeNull();
  });

  it('old roles-only config validates unchanged', () => {
    const parsed = ConfigSchema.parse({ version: 1, roles: { head: 'claude', developmentLead: 'codex' } });
    expect(parsed.roles).toEqual({ head: 'claude', developmentLead: 'codex' });
  });

  it('profiles validate with arbitrary user-defined names', () => {
    const parsed = ConfigSchema.parse({
      version: 1,
      profiles: {
        daily: { head: 'claude', developmentLead: 'claude' },
        'review-heavy': { head: 'codex', developmentLead: 'claude' },
        'my weird profile 2': { head: 'codex', developmentLead: 'codex' },
      },
    });
    expect(Object.keys(parsed.profiles)).toHaveLength(3);
  });

  it('rejects invalid providers inside profiles', () => {
    const result = ConfigSchema.safeParse({
      version: 1,
      profiles: { daily: { head: 'gemini', developmentLead: 'claude' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a defaultProfile that references no existing profile', () => {
    const result = ConfigSchema.safeParse({ version: 1, defaultProfile: 'daily', profiles: {} });
    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error.issues[0]?.message).toContain('does not exist');
  });

  it('rejects empty profile names', () => {
    const result = ConfigSchema.safeParse({
      version: 1,
      profiles: { '': { head: 'claude', developmentLead: 'claude' } },
    });
    expect(result.success).toBe(false);
  });
});

describe('resolveTeam resolution order', () => {
  const config = ConfigSchema.parse({
    version: 1,
    roles: { head: 'codex', developmentLead: 'claude' },
    defaultProfile: 'daily',
    profiles: {
      daily: { head: 'claude', developmentLead: 'claude' },
      'review-heavy': { head: 'codex', developmentLead: 'claude' },
    },
  });

  it('explicit profile wins over defaultProfile and roles', () => {
    expect(resolveTeam(config, 'review-heavy')).toEqual({
      profile: 'review-heavy',
      head: 'codex',
      developmentLead: 'claude',
    });
  });

  it('defaultProfile wins over roles when no explicit profile', () => {
    expect(resolveTeam(config)).toEqual({ profile: 'daily', head: 'claude', developmentLead: 'claude' });
  });

  it('falls back to roles when neither profile source exists', () => {
    const noProfiles = ConfigSchema.parse({ version: 1, roles: { head: 'claude', developmentLead: 'codex' } });
    expect(resolveTeam(noProfiles)).toEqual({ profile: null, head: 'claude', developmentLead: 'codex' });
  });

  it('falls back to built-in defaults when nothing is configured', () => {
    expect(resolveTeam(ConfigSchema.parse({ version: 1 }))).toEqual({
      profile: null,
      head: 'codex',
      developmentLead: 'claude',
    });
  });

  it('throws a clear ConfigError for unknown explicit profiles', () => {
    expect(() => resolveTeam(config, 'nonexistent')).toThrow(ConfigError);
    expect(() => resolveTeam(config, 'nonexistent')).toThrow(/unknown profile "nonexistent".*daily.*review-heavy/s);
  });
});
