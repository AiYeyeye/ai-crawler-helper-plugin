import type { SessionId } from "../shared/ids";
import type { SessionRecord } from "../schemas/session";
import type { BusinessError } from "../shared/errors";

/**
 * Collector pipeline contracts consumed by subtasks 02–07.
 *
 * The foundation build defines these interfaces and the session service
 * refuses to enter `recording` until a pipeline implementing them is
 * registered (error `CAPTURE_PIPELINE_UNAVAILABLE`) — no fake recording.
 */

export interface CollectorStartContext {
  readonly session: SessionRecord;
}

export type CollectorStartResult =
  | { ok: true }
  | { ok: false; error: BusinessError };

/**
 * A capture collector participating in a session (content-script bootstrap,
 * debugger network recorder, navigation recorder, storage collector).
 * All facts a collector produces MUST be submitted as EventEnvelopes through
 * the FactIngestor — collectors never write IndexedDB directly.
 */
export interface CaptureCollector {
  readonly name: "content_script" | "debugger_network" | "navigation" | "storage";
  /** Attach/enable for the session. Failing critical init aborts start. */
  start(context: CollectorStartContext): Promise<CollectorStartResult>;
  /** Idempotent teardown; must be callable repeatedly (design 16). */
  stop(sessionId: SessionId): Promise<void>;
  /** Hard disconnect used by storage-pressure safe-stop. Idempotent. */
  disconnect(sessionId: SessionId): Promise<void>;
}

/** Registered by subtask 02+; the session service consumes it. */
export interface CollectorPipeline {
  readonly collectors: readonly CaptureCollector[];
}
