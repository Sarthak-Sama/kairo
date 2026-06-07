import { loadConfig, resolveTeam } from '../core/config.js';

/** List the user-defined operating profiles and the effective default team. */
export async function profilesCommand(repoRoot: string): Promise<void> {
  const config = await loadConfig(repoRoot);
  const names = Object.keys(config.profiles);

  if (names.length === 0) {
    console.log('[kairo] no profiles configured. Define them in .kairo/config.json under "profiles", e.g.:');
    console.log('  "profiles": { "daily": { "head": "claude", "developmentLead": "claude" } }');
  } else {
    const width = Math.max(...names.map((n) => n.length), 8);
    for (const name of names) {
      const p = config.profiles[name]!;
      const marker = config.defaultProfile === name ? '  default' : '';
      console.log(`  ${name.padEnd(width)}   head=${p.head}  development=${p.developmentLead}${marker}`);
    }
  }

  const effective = resolveTeam(config);
  console.log(
    `\n[kairo] without --profile, runs use: ${effective.profile ?? 'roles config'} (head=${effective.head}, development=${effective.developmentLead})`,
  );
}
