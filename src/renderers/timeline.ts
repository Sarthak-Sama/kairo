import type { AgencyEvent } from '../core/events.js';

/**
 * Live timeline renderer. One line per event:
 *   [head:codex] inspecting repo
 *   [development:claude] implementing phase 1
 * Professional and terse — no spinners, no decoration beyond actor tags.
 */
export class TimelineRenderer {
  constructor(private readonly out: NodeJS.WritableStream = process.stdout) {}

  render(event: AgencyEvent): void {
    let line = `${actorTag(event)} ${event.message}`;
    if (event.status === 'failed') line += ' (failed)';
    if (event.status === 'skipped') line += ' (skipped)';
    this.out.write(line + '\n');
  }

  info(message: string): void {
    this.out.write(`[kairo] ${message}\n`);
  }
}

/** `[head:claude]` / `[development:codex]` when provider metadata is present. */
export function actorTag(event: AgencyEvent): string {
  const label = event.actor === 'development_lead' ? 'development' : event.actor;
  const provider = typeof event.metadata.provider === 'string' ? event.metadata.provider : null;
  return provider && (event.actor === 'head' || event.actor === 'development_lead')
    ? `[${label}:${provider}]`
    : `[${label}]`;
}

export function formatEventLine(event: AgencyEvent): string {
  const time = event.timestamp.slice(11, 19);
  return `${time} ${actorTag(event)} ${event.action} ${event.status} — ${event.message}`;
}
