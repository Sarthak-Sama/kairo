import { fileExists, readText } from '../utils/fs.js';

/**
 * Observed by adapters/transports during an active model call so Kairo can
 * terminate child processes it owns. This is transport-owned process
 * termination — never process-name killing, never global.
 */
export interface CancellationSignal {
  isCancellationRequested(): Promise<boolean>;
  reason(): Promise<string | null>;
}

/** A signal that never fires — for callers without a control channel. */
export const NEVER_CANCELLED: CancellationSignal = {
  isCancellationRequested: async () => false,
  reason: async () => null,
};

/**
 * File-backed signal: `kairo stop` writes `.kairo/tasks/<id>/control.json`
 * (`{ stopRequested: true, reason, requestedAt }`); active transports poll it.
 * Also honors the pre-cancellation `stop-requested.json` flag for
 * compatibility. A positive result is cached — cancellation never un-happens.
 */
export class FileCancellationSignal implements CancellationSignal {
  private cancelled = false;
  private cachedReason: string | null = null;

  constructor(private readonly paths: string[]) {}

  async isCancellationRequested(): Promise<boolean> {
    if (this.cancelled) return true;
    for (const path of this.paths) {
      if (!(await fileExists(path))) continue;
      try {
        const raw = JSON.parse(await readText(path)) as { stopRequested?: boolean; reason?: string };
        if (raw.stopRequested === false) continue; // explicit off-switch shape
        this.cancelled = true;
        this.cachedReason = raw.reason ?? null;
        return true;
      } catch {
        // unreadable control file still counts as a stop request
        this.cancelled = true;
        return true;
      }
    }
    return false;
  }

  async reason(): Promise<string | null> {
    await this.isCancellationRequested();
    return this.cachedReason;
  }
}
