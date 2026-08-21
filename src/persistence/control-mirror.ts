import type { MinimalStopRecord } from "../schemas/session";

/**
 * Best-effort control-plane mirror (design 12.1 / research section 5).
 *
 * The mirror is NOT a source of truth and NOT an independent failure domain;
 * correctness always rests on `sessionControl` in IndexedDB plus unclean-epoch
 * inference at startup. Mirror failures are swallowed by contract.
 */
export interface ControlMirror {
  mirrorStopRecord(record: MinimalStopRecord): Promise<void>;
}

/** chrome.storage.local mirror used in the real extension runtime. */
export class ChromeStorageControlMirror implements ControlMirror {
  async mirrorStopRecord(record: MinimalStopRecord): Promise<void> {
    try {
      await chrome.storage.local.set({ [`stopRecord:${record.sessionId}`]: record });
    } catch {
      // Best effort by contract: startup recovery infers from sessionControl.
    }
  }
}

/** In-memory mirror for tests / non-extension contexts. */
export class InMemoryControlMirror implements ControlMirror {
  readonly records: MinimalStopRecord[] = [];
  mirrorStopRecord(record: MinimalStopRecord): Promise<void> {
    this.records.push(record);
    return Promise.resolve();
  }
}
