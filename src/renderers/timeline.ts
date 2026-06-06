import type { AgencyEvent } from '../core/events.js';

/**
 * Live timeline renderer. One line per event:
 *   [codex] inspecting repo
 *   [claude] implementing phase 1
 * Professional and terse — no spinners, no decoration beyond actor tags.
 */
export class TimelineRenderer {
  constructor(private readonly out: NodeJS.WritableStream = process.stdout) {}

  render(event: AgencyEvent): void {
    const tag = `[${event.actor}]`;
    let line = `${tag} ${event.message}`;
    if (event.status === 'failed') line += ' (failed)';
    if (event.status === 'skipped') line += ' (skipped)';
    this.out.write(line + '\n');
  }

  info(message: string): void {
    this.out.write(`[kairo] ${message}\n`);
  }
}

export function formatEventLine(event: AgencyEvent): string {
  const time = event.timestamp.slice(11, 19);
  return `${time} [${event.actor}] ${event.action} ${event.status} — ${event.message}`;
}
