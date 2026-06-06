import { z } from 'zod';
import { join } from 'node:path';
import { fileExists, readJson, writeJson } from '../utils/fs.js';

export const CheckSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
});

export const ConfigSchema = z.object({
  version: z.literal(1),
  artifactDir: z.string().default('.kairo'),
  limits: z
    .object({
      maxPhases: z.number().int().positive().default(6),
      maxRevisionLoopsPerPhase: z.number().int().positive().default(3),
      maxTotalModelCalls: z.number().int().positive().default(20),
      maxRuntimeMinutes: z.number().int().positive().default(90),
    })
    .default({}),
  codex: z
    .object({
      command: z.string().default('codex'),
      model: z.string().nullable().default(null),
      sandbox: z.string().default('workspace-write'),
    })
    .default({}),
  claude: z
    .object({
      command: z.string().default('claude'),
      model: z.string().default('sonnet'),
      permissionMode: z.string().default('auto'),
    })
    .default({}),
  checks: z.array(CheckSchema).default([]),
  scanner: z
    .object({
      exclude: z.array(z.string()).default([]),
    })
    .default({}),
});

export type KairoConfig = z.infer<typeof ConfigSchema>;
export type CheckConfig = z.infer<typeof CheckSchema>;

export const DEFAULT_CONFIG: KairoConfig = {
  version: 1,
  artifactDir: '.kairo',
  limits: {
    maxPhases: 6,
    maxRevisionLoopsPerPhase: 3,
    maxTotalModelCalls: 20,
    maxRuntimeMinutes: 90,
  },
  codex: {
    command: 'codex',
    model: null,
    sandbox: 'workspace-write',
  },
  claude: {
    command: 'claude',
    model: 'sonnet',
    permissionMode: 'auto',
  },
  checks: [
    { name: 'typecheck', command: 'pnpm typecheck' },
    { name: 'lint', command: 'pnpm lint' },
    { name: 'test', command: 'pnpm test' },
    { name: 'build', command: 'pnpm build' },
  ],
  scanner: {
    exclude: [
      '.git/**',
      '.kairo/**',
      'node_modules/**',
      'dist/**',
      'build/**',
      '.next/**',
      'coverage/**',
    ],
  },
};

export function configPath(repoRoot: string): string {
  return join(repoRoot, '.kairo', 'config.json');
}

export async function configExists(repoRoot: string): Promise<boolean> {
  return fileExists(configPath(repoRoot));
}

export async function loadConfig(repoRoot: string): Promise<KairoConfig> {
  const path = configPath(repoRoot);
  if (!(await fileExists(path))) {
    throw new ConfigError(`No Kairo config found at ${path}. Run \`kairo init\` first.`);
  }
  let raw: unknown;
  try {
    raw = await readJson<unknown>(path);
  } catch (err) {
    throw new ConfigError(`Config at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Config at ${path} failed validation:\n${issues}`);
  }
  return parsed.data;
}

export async function writeDefaultConfig(repoRoot: string): Promise<string> {
  const path = configPath(repoRoot);
  await writeJson(path, DEFAULT_CONFIG);
  return path;
}

export class ConfigError extends Error {}
