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

export interface FollowOptions {
  /** Poll interval; small in tests, ~500ms for the CLI. */
  pollIntervalMs?: number;
  /**
   * Checked after each poll; returning true performs one final read and
   * stops. Used to stop when the task reaches a terminal/paused state.
   */
  isDone?: () => boolean | Promise<boolean>;
}

/**
 * Tail an NDJSON event log: emit events already present, then poll for
 * appended lines until `isDone` reports true. Byte-offset based — lines are
 * never re-emitted. Resolves with the number of events delivered.
 */
export async function followEventLog(
  logPath: string,
  listener: EventListener,
  options: FollowOptions = {},
): Promise<number> {
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  let offset = 0;
  let carry = '';
  let delivered = 0;

  const drain = async (): Promise<void> => {
    if (!(await fileExists(logPath))) return;
    const raw = await readText(logPath);
    if (raw.length <= offset) return;
    const fresh = carry + raw.slice(offset);
    offset = raw.length;
    const lines = fresh.split('\n');
    carry = lines.pop() ?? ''; // hold a trailing partial line for the next poll
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        listener(AgencyEventSchema.parse(JSON.parse(line)));
        delivered++;
      } catch {
        // malformed line — skip here; readEventLog surfaces these on demand
      }
    }
  };

  for (;;) {
    await drain();
    if (await options.isDone?.()) {
      await drain(); // final read so nothing written during the check is lost
      return delivered;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
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
