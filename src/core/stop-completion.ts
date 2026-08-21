import type { BusinessError, Result } from "../shared/errors";
import type { SessionId } from "../shared/ids";

/** Remaining portion of the durable late-response window after worker restart. */
export const remainingStopCompletionDelayMs = (
  stopRequestedAt: number,
  lateResponseWindowMs: number,
  now: number,
): number => Math.max(0, stopRequestedAt + lateResponseWindowMs - now);

// ---------------------------------------------------------------------------
// Quiescent early-exit support (adaptive stop window)
//
// The late-response window exists to admit facts from producers that deliver
// asynchronously (content scripts, CDP events). Most sessions go quiet long
// before the 10 s cap, so a stop that has already seen activity and then stays
// quiet for STOP_QUIESCENT_WINDOW_MS may complete early. Sessions that show NO
// activity inside the window (e.g. a throttled background tab) keep the full
// window — their producer may still be asleep.
// ---------------------------------------------------------------------------

/** Per-session ingest activity seen during the stop window. */
export interface StopActivityTracker {
  markActivity(sessionId: SessionId): void;
  activityCount(sessionId: SessionId): number;
  lastActivityAt(sessionId: SessionId): number | null;
  clear(sessionId: SessionId): void;
}

export const createStopActivityTracker = (
  now: () => number = Date.now,
): StopActivityTracker => {
  const lastActivityAt = new Map<SessionId, number>();
  const activityCount = new Map<SessionId, number>();
  return {
    markActivity(sessionId: SessionId): void {
      lastActivityAt.set(sessionId, now());
      activityCount.set(sessionId, (activityCount.get(sessionId) ?? 0) + 1);
    },
    activityCount(sessionId: SessionId): number {
      return activityCount.get(sessionId) ?? 0;
    },
    lastActivityAt(sessionId: SessionId): number | null {
      return lastActivityAt.get(sessionId) ?? null;
    },
    clear(sessionId: SessionId): void {
      lastActivityAt.delete(sessionId);
      activityCount.delete(sessionId);
    },
  };
};

export interface StopEarlyExitOptions {
  /** Never complete before this many ms into the stop window. */
  readonly minEarlyExitWindowMs: number;
  /** Quiet period that permits early completion. */
  readonly quiescentWindowMs: number;
}

/**
 * True when the stop may complete before the full late-response window:
 * at least minEarlyExitWindowMs elapsed AND at least one fact was ingested
 * inside the window AND no fact for quiescentWindowMs. A session with zero
 * observed activity keeps the full window (producer may be throttled).
 */
export const shouldCompleteStopEarly = (
  now: number,
  stopRequestedAt: number,
  tracker: StopActivityTracker,
  sessionId: SessionId,
  options: StopEarlyExitOptions,
): boolean => {
  if (now - stopRequestedAt < options.minEarlyExitWindowMs) {
    return false;
  }
  if (tracker.activityCount(sessionId) === 0) {
    return false;
  }
  const lastActivityAt = tracker.lastActivityAt(sessionId);
  if (lastActivityAt === null) {
    return false;
  }
  return now - lastActivityAt >= options.quiescentWindowMs;
};

export interface SessionStopCompletionOptions {
  sealAndDrainNavigation(): Promise<void>;
  finalizeObservations(): Promise<void>;
  stopCollectors: readonly (() => Promise<void>)[];
  persistCleanCompletion(): Promise<void>;
  cleanupRuntime(): void;
}

export interface StoppingSessionRecoveryOptions {
  restoreCollectors(): Promise<Result<void>>;
  persistDegradedRecovery(error: BusinessError): Promise<void>;
  scheduleCompletion(): void;
}

/** Never schedule a timer-only stopping window without durable degradation evidence. */
export const recoverStoppingSession = async (
  options: StoppingSessionRecoveryOptions,
): Promise<void> => {
  const restored = await options.restoreCollectors();
  if (!restored.ok) {
    await options.persistDegradedRecovery(restored.error);
  }
  options.scheduleCompletion();
};

/** A clean stop is durable only when every admitted producer drains successfully. */
export const completeSessionStop = async (
  options: SessionStopCompletionOptions,
): Promise<void> => {
  const failures: unknown[] = [];
  const attempt = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (cause: unknown) {
      failures.push(cause);
    }
  };

  // eslint-disable-next-line @typescript-eslint/unbound-method -- attempt is a local arrow function
  await attempt(options.sealAndDrainNavigation);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- attempt is a local arrow function
  await attempt(options.finalizeObservations);
  for (const stopCollector of options.stopCollectors) {
    await attempt(stopCollector);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "stop cleanup failed");
  }

  await options.persistCleanCompletion();
  options.cleanupRuntime();
};
