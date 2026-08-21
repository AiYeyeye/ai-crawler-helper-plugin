/**
 * Calibration + product constants in ONE module (task hard constraint).
 *
 * IMPORTANT — calibration status:
 * Every constant marked [UNCALIBRATED] has NOT been calibrated on real
 * Chrome/Edge machines. Real-machine calibration is subtask 08; until then
 * these are engineering placeholders, NOT platform facts
 * (research/storage-export-capacity.md section 4, task prd Notes).
 */

/** Product default: per-session response-body soft budget. 100 MiB. */
export const DEFAULT_RESPONSE_BODY_SOFT_BUDGET_BYTES = 100 * 1024 * 1024;

/** Product default: single text response body cap. 2 MiB. */
export const DEFAULT_RESPONSE_BODY_MAX_BYTES = 2 * 1024 * 1024;

/** Product default: network quiet window closing a step (PRD 3.3). */
export const NETWORK_QUIET_WINDOW_MS = 800;

/** Product default: max convergence window for an ordinary step (PRD 3.3). */
export const STEP_MAX_WINDOW_MS = 10_000;

/** Product default: hover dwell threshold (PRD 4.2, configurable). */
export const HOVER_DWELL_THRESHOLD_MS = 500;

/** Product default: input batch quiet window (PRD 4.2). */
export const INPUT_BATCH_QUIET_WINDOW_MS = 800;

/** Product default: max wait for in-flight requests on stop (PRD 4.1). */
export const STOP_LATE_RESPONSE_WINDOW_MS = 10_000;

/**
 * Minimum elapsed window before a quiescent stop may complete early.
 *
 * Bounds the exposure of the early-exit heuristic: only stops that have been
 * quiet for STOP_QUIESCENT_WINDOW_MS after at least this much time may finish
 * before the full late-response window.
 */
export const STOP_MIN_EARLY_EXIT_WINDOW_MS = 4_000;

/**
 * Quiet period (no ingested fact for the session) that permits early stop
 * completion. Only meaningful once the session has seen at least one ingest
 * inside the stop window — a silent session (e.g. throttled background tab)
 * always keeps the full late-response window.
 */
export const STOP_QUIESCENT_WINDOW_MS = 3_000;

/** Poll cadence of the adaptive stop-completion scheduler. */
export const STOP_COMPLETION_POLL_MS = 500;

/** Product default: single-JSON export threshold. 10 MiB (PRD 4.16). */
export const SINGLE_JSON_EXPORT_MAX_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// CapacityGuard admission parameters — see core/capacity-guard.ts
// ---------------------------------------------------------------------------

export interface CapacityGuardConfig {
  /**
   * [UNCALIBRATED] Safety margin added to every admission check to absorb
   * `navigator.storage.estimate()` imprecision (compression, dedup,
   * anti-fingerprinting fuzzing). Placeholder pending subtask-08 calibration
   * on real Chrome/Edge with varying disk headroom.
   */
  estimateErrorMarginBytes: number;
  /**
   * [UNCALIBRATED] Headroom reserved so that a durable safe-stop record and
   * control-plane updates can still be written after admission is closed.
   * Placeholder pending subtask-08 calibration.
   */
  durableStopReserveBytes: number;
  /**
   * [UNCALIBRATED] Maximum single-transaction logical size. Larger writes are
   * rejected (transaction_too_large) instead of risking an oversized commit.
   * Placeholder pending subtask-08 calibration.
   */
  maxTransactionBytes: number;
  /**
   * [UNCALIBRATED] Re-run `estimate()` after this many logical bytes have been
   * committed since the previous estimate (avoid per-event blocking probes).
   * Placeholder pending subtask-08 calibration.
   */
  reestimateIntervalBytes: number;
}

/** [UNCALIBRATED] Defaults; all values pending subtask-08 real-machine runs. */
export const DEFAULT_CAPACITY_GUARD_CONFIG: CapacityGuardConfig = {
  estimateErrorMarginBytes: 64 * 1024 * 1024,
  durableStopReserveBytes: 16 * 1024 * 1024,
  maxTransactionBytes: 32 * 1024 * 1024,
  reestimateIntervalBytes: 8 * 1024 * 1024,
};

/**
 * [UNCALIBRATED] Export read batch size (rows per short read transaction) and
 * ZIP chunk cap; consumed by subtask 07. Placeholders pending calibration.
 */
export const EXPORT_READ_BATCH_ROWS = 200;
export const EXPORT_ZIP_CHUNK_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// DOM serialization budget (task 08: dom-capture-budget)
// ---------------------------------------------------------------------------

/** [UNCALIBRATED] Max recursion depth for a single `serializeDomNode` call. */
export const DOM_SERIALIZE_MAX_DEPTH = 32;

/** [UNCALIBRATED] Max node count in a single `serializeDomNode` call. */
export const DOM_SERIALIZE_MAX_NODES = 500;

/** [UNCALIBRATED] Max attributes inspected in a single DOM serialization call. */
export const DOM_SERIALIZE_MAX_ATTRIBUTES = 500;

/** [UNCALIBRATED] Max cumulative estimated bytes per `serializeDomNode` call. 256 KiB. */
export const DOM_SERIALIZE_MAX_BYTES = 256 * 1024;

/**
 * [UNCALIBRATED] Max root nodes processed per MutationObserver batch.
 * Batches exceeding this degrade to summary + truncation marker.
 */
export const DOM_MUTATION_BATCH_MAX_ROOTS = 50;

/** Max retained mutation records between drains. */
export const DOM_MUTATION_PENDING_MAX_RECORDS = 128;

/** Max actual UTF-8 bytes retained by the mutation queue. 256 KiB. */
export const DOM_MUTATION_PENDING_MAX_BYTES = 256 * 1024;

/** Max UTF-8 bytes retained from locator-visible text. */
export const DOM_LOCATOR_VISIBLE_TEXT_MAX_BYTES = 512;

/** [UNCALIBRATED] Maximum buffered CDP events for one source/request chain. */
export const NETWORK_PENDING_EVENT_MAX_COUNT = 256;

/** [UNCALIBRATED] Maximum UTF-8 bytes buffered for one source/request chain. */
export const NETWORK_PENDING_EVENT_MAX_BYTES = 256 * 1024;

/** [UNCALIBRATED] Maximum wait for request scope or CDP clock correlation. */
export const NETWORK_PENDING_EVENT_DEADLINE_MS = 5_000;
