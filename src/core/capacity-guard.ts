import type { CapacityGuardConfig } from "./config";

/**
 * Hard CapacityGuard (PRD 4.13, design 12.1).
 *
 * The user-configurable response-body soft budget is a DIFFERENT mechanism
 * (enforced in the fact committer). This guard is NOT user-disableable and
 * gates every write with a conservative headroom admission rule:
 *
 * ```
 * estimatedHeadroom = quota - usage
 * requiredHeadroom  = nextTransactionEstimate
 *                   + durableStopReserve
 *                   + estimateErrorMargin
 * ```
 *
 * Reject (→ safe-stop) when: estimate failed/invalid, headroom insufficient,
 * the single transaction is too large, or the previous write failed with a
 * quota/I-O class error. All numeric parameters are [UNCALIBRATED] until
 * subtask 08 (see core/config.ts).
 *
 * Unstable Service Worker heap numbers are deliberately NOT an input
 * (peak memory is bounded structurally: fixed batches, chunk caps,
 * backpressure — never measured heap).
 */

export interface StorageEstimateSnapshot {
  quota: number;
  usage: number;
}

export type StorageEstimateProvider = () => Promise<StorageEstimateSnapshot>;

export type AdmissionDecision =
  | {
      admitted: true;
      estimatedHeadroom: number;
      requiredHeadroom: number;
      checkedAt: number;
    }
  | {
      admitted: false;
      reason:
        | "estimate_unavailable"
        | "insufficient_headroom"
        | "transaction_too_large"
        | "previous_write_failed";
      estimatedHeadroom?: number;
      requiredHeadroom?: number;
      checkedAt: number;
    };

export class CapacityGuard {
  private lastWriteFailure: { at: number; kind: "quota" | "io" } | null = null;
  private cachedEstimate: { snapshot: StorageEstimateSnapshot; at: number } | null = null;
  private bytesSinceEstimate = 0;

  constructor(
    private readonly estimateProvider: StorageEstimateProvider,
    private readonly config: CapacityGuardConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Record a quota/I-O failure from the persistence layer. */
  reportWriteFailure(kind: "quota" | "io"): void {
    this.lastWriteFailure = { at: this.now(), kind };
  }

  /** Called after a successful commit so re-estimation intervals advance. */
  reportCommittedBytes(bytes: number): void {
    this.bytesSinceEstimate += bytes;
  }

  /** Explicit reset used by the user-driven resume flow after space freed. */
  clearWriteFailure(): void {
    this.lastWriteFailure = null;
    this.cachedEstimate = null;
    this.bytesSinceEstimate = 0;
  }

  async admit(nextTransactionEstimateBytes: number): Promise<AdmissionDecision> {
    const checkedAt = this.now();

    if (this.lastWriteFailure !== null) {
      return { admitted: false, reason: "previous_write_failed", checkedAt };
    }

    if (nextTransactionEstimateBytes > this.config.maxTransactionBytes) {
      return { admitted: false, reason: "transaction_too_large", checkedAt };
    }

    const snapshot = await this.obtainEstimate();
    if (snapshot === null) {
      return { admitted: false, reason: "estimate_unavailable", checkedAt };
    }

    const estimatedHeadroom = snapshot.quota - snapshot.usage - this.bytesSinceEstimate;
    const requiredHeadroom =
      nextTransactionEstimateBytes +
      this.config.durableStopReserveBytes +
      this.config.estimateErrorMarginBytes;

    if (
      !Number.isFinite(estimatedHeadroom) ||
      estimatedHeadroom <= requiredHeadroom
    ) {
      return {
        admitted: false,
        reason: "insufficient_headroom",
        estimatedHeadroom,
        requiredHeadroom,
        checkedAt,
      };
    }

    return { admitted: true, estimatedHeadroom, requiredHeadroom, checkedAt };
  }

  private async obtainEstimate(): Promise<StorageEstimateSnapshot | null> {
    const mustRefresh =
      this.cachedEstimate === null ||
      this.bytesSinceEstimate >= this.config.reestimateIntervalBytes;
    if (!mustRefresh && this.cachedEstimate !== null) {
      return this.cachedEstimate.snapshot;
    }
    try {
      const snapshot = await this.estimateProvider();
      if (
        !Number.isFinite(snapshot.quota) ||
        !Number.isFinite(snapshot.usage) ||
        snapshot.quota < 0 ||
        snapshot.usage < 0
      ) {
        return null;
      }
      this.cachedEstimate = { snapshot, at: this.now() };
      this.bytesSinceEstimate = 0;
      return snapshot;
    } catch {
      // estimate() failure is itself a pause condition — never guessed around.
      return null;
    }
  }
}

/** Default provider backed by navigator.storage.estimate (browser contexts). */
export const navigatorStorageEstimateProvider: StorageEstimateProvider = async () => {
  const estimate = await navigator.storage.estimate();
  if (estimate.quota === undefined || estimate.usage === undefined) {
    throw new Error("storage estimate returned no quota/usage");
  }
  return { quota: estimate.quota, usage: estimate.usage };
};
