import { z } from 'zod';
import { appendText, fileExists, readText } from '../utils/fs.js';

export const AgencyEventSchema = z.object({
  timestamp: z.string(),
  actor: z.enum(['kairo', 'codex', 'claude', 'user', 'checks']),
  action: z.string().min(1),
  status: z.enum(['started', 'completed', 'failed', 'skipped']),
  message: z.string(),
  metadata: z.record(z.unknown()).default({}),
});

export type AgencyEvent = z.infer<typeof AgencyEventSchema>;
export type AgencyEventInput = Omit<AgencyEvent, 'timestamp' | 'metadata'> & {
  metadata?: Record<string, unknown>;
};

export type EventListener = (event: AgencyEvent) => void;

/**
 * Append-only NDJSON event log. This is the audit trail for a task run:
 * every meaningful decision and transition gets one line.
 */
export class EventLogger {
  private listeners: EventListener[] = [];

  constructor(
    private readonly logPath: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  onEvent(listener: EventListener): void {
    this.listeners.push(listener);
  }

  async log(input: AgencyEventInput): Promise<AgencyEvent> {
    const event: AgencyEvent = {
      timestamp: this.clock().toISOString(),
      actor: input.actor,
      action: input.action,
      status: input.status,
      message: input.message,
      metadata: input.metadata ?? {},
    };
    await appendText(this.logPath, JSON.stringify(event) + '\n');
    for (const listener of this.listeners) {
      listener(event);
    }
    return event;
  }
}

/** Read all events back from an NDJSON log. Malformed lines are surfaced, not dropped silently. */
export async function readEventLog(
  logPath: string,
): Promise<{ events: AgencyEvent[]; malformedLines: number[] }> {
  if (!(await fileExists(logPath))) {
    return { events: [], malformedLines: [] };
  }
  const raw = await readText(logPath);
  const events: AgencyEvent[] = [];
  const malformedLines: number[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const parsed = AgencyEventSchema.parse(JSON.parse(line));
      events.push(parsed);
    } catch {
      malformedLines.push(i + 1);
    }
  }
  return { events, malformedLines };
}
