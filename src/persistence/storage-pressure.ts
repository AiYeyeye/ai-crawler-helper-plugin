import {
  SESSION_INDEX,
  STORES,
  getAllRecords,
  getRecord,
  requestToPromise,
  runAtomicWrite,
} from "./database";
import {
  minimalStopRecordSchema,
  sessionControlRecordSchema,
  sessionRecordSchema,
  type SessionControlRecord,
} from "../schemas/session";
import { captureGapRecordSchema, type CaptureGapRecord } from "../schemas/capture-gap";
import { SCHEMA_VERSION } from "../schemas/common";
import { newCaptureEpochId, newGapId, type CaptureEpochId, type GapId, type SessionId } from "../shared/ids";
import { transition } from "../core/session-state-machine";
import { businessError, err, ok, type BusinessError, type Result } from "../shared/errors";
import type { CapacityGuard } from "../core/capacity-guard";
import type { ControlMirror } from "./control-mirror";
import { storedStepSchema, type DraftStep, type StoredStep } from "../schemas/step";

/**
 * Storage-pressure safe-stop + explicit resume (PRD 4.13, design 12.1).
 *
 * Safe stop: the current fact transaction has already fully committed or
 * fully rolled back by the time this runs (FactIngestor contract). We then:
 *   1. atomically move session to `paused_storage_pressure` and open a
 *      session-wide CaptureGap for the pause interval,
 *   2. best-effort mirror a minimal stop record to the control plane.
 * DOM facts are never trimmed; all committed data remains inspectable and
 * exportable in the paused state.
 *
 * Resume: user-explicit only. Requires a fresh capacity admission pass, then
 * atomically opens a NEW capture epoch, closes the pause gap with recovery
 * metadata, and reopens the fact gate. The paused interval stays a gap —
 * nothing is backfilled.
 */

export type PauseReason = "headroom_exhausted" | "quota_exceeded_error" | "io_write_failed";

export interface PreparedStoragePressureResume {
  activate(): Promise<Result<void>>;
  rollback(): Promise<void>;
}

export interface StoragePressureLifecycleHooks {
  onPaused(sessionId: SessionId): Promise<void>;
  onResumed(
    sessionId: SessionId,
    captureEpochId: CaptureEpochId,
  ): Promise<Result<PreparedStoragePressureResume | undefined>>;
}

export class StoragePressureController {
  private lifecycleHooks: StoragePressureLifecycleHooks | null = null;
  private readonly quiescedSessions = new Set<SessionId>();

  constructor(
    private readonly db: IDBDatabase,
    private readonly mirror: ControlMirror,
  ) {}

  setLifecycleHooks(hooks: StoragePressureLifecycleHooks): void {
    this.lifecycleHooks = hooks;
  }

  /** Idempotent: re-invocation while already paused returns the open gap. */
  async safeStop(sessionId: SessionId, reason: PauseReason, now: number): Promise<GapId | null> {
    let outcome: {
      gapId: GapId | null;
      control: SessionControlRecord | null;
      shouldCoordinate: boolean;
    } = {
      gapId: null,
      control: null,
      shouldCoordinate: true,
    };
    let durableFailure: unknown;
    try {
      outcome = await runAtomicWrite(
        this.db,
        [
          STORES.sessions,
          STORES.sessionControl,
          STORES.captureGaps,
          STORES.steps,
          STORES.inFlightRequests,
        ],
        async (txn) => {
          const controlStore = txn.objectStore(STORES.sessionControl);
          const sessionsStore = txn.objectStore(STORES.sessions);
          const controlRaw = await getRecord(controlStore, sessionId);
          const sessionRaw = await getRecord(sessionsStore, sessionId);
          if (controlRaw === undefined || sessionRaw === undefined) {
            return { gapId: null, control: null, shouldCoordinate: false };
          }
          const control = sessionControlRecordSchema.parse(controlRaw);
          const session = sessionRecordSchema.parse(sessionRaw);

          if (control.pause !== undefined) {
            await reconcilePausedRuntimeState(txn, sessionId, control.pause.gapId, now);
            if (control.openStepIds.length > 0 || control.resumeAttempt !== undefined) {
              const { resumeAttempt: _resumeAttempt, ...controlWithoutAttempt } = control;
              controlStore.put(
                sessionControlRecordSchema.parse({
                  ...controlWithoutAttempt,
                  openStepIds: [],
                }),
              );
            }
            return {
              gapId: control.pause.gapId,
              control: null,
              shouldCoordinate: true,
            };
          }
          const result = transition(session.lifecycle, "storage_pressure_pause");
          if (result.outcome !== "transitioned") {
            return { gapId: null, control: null, shouldCoordinate: false };
          }

          const newGapId = newGapId_();
          const gap: CaptureGapRecord = captureGapRecordSchema.parse({
            schemaVersion: SCHEMA_VERSION,
            gapId: newGapId,
            scope: { sessionId, collector: "all" },
            reason: "storage_pressure_paused",
            observedStartedAt: now,
            boundaryConfidence: "exact",
            recoverable: true,
            affectedCapabilities: ["all"],
          });
          txn.objectStore(STORES.captureGaps).put(gap);
          await reconcilePausedRuntimeState(txn, sessionId, newGapId, now);

          const { resumeAttempt: _resumeAttempt, ...controlWithoutAttempt } = control;
          const updatedControl = sessionControlRecordSchema.parse({
            ...controlWithoutAttempt,
            lifecycle: result.next,
            pause: { reason, pausedAt: now, gapId: newGapId },
            openStepIds: [],
          });
          controlStore.put(updatedControl);
          sessionsStore.put(
            sessionRecordSchema.parse({
              ...session,
              lifecycle: result.next,
              captureQuality: "degraded",
            }),
          );
          return { gapId: newGapId, control: updatedControl, shouldCoordinate: true };
        },
      );
    } catch (cause: unknown) {
      durableFailure = cause;
    }

    let coordinationFailure: unknown;
    if (outcome.shouldCoordinate && !this.quiescedSessions.has(sessionId)) {
      try {
        await this.lifecycleHooks?.onPaused(sessionId);
        this.quiescedSessions.add(sessionId);
      } catch (cause: unknown) {
        coordinationFailure = cause;
      }
    }
    const controlForMirror = outcome.control;
    if (controlForMirror !== null) {
      try {
        await this.mirror.mirrorStopRecord(
          minimalStopRecordSchema.parse({
            schemaVersion: SCHEMA_VERSION,
            sessionId: controlForMirror.sessionId,
            captureEpochId: controlForMirror.captureEpochId,
            state: "paused_storage_pressure",
            reasonCode: reason,
            pausedAt: now,
            ...(controlForMirror.lastCommittedAt !== undefined
              ? { lastCommittedAt: controlForMirror.lastCommittedAt }
              : {}),
          }),
        );
      } catch {
        // The control-plane mirror is explicitly best effort.
      }
    }
    if (durableFailure !== undefined || coordinationFailure !== undefined) {
      throw new StoragePressurePauseError(
        businessError(
          "PERSISTENCE_TRANSACTION_FAILED",
          durableFailure === undefined
            ? "capture producers could not be fully quiesced after storage pressure"
            : "storage-pressure pause transaction failed after producers were quiesced",
          { sessionId, retryable: true },
        ),
        durableFailure ?? coordinationFailure,
      );
    }
    return outcome.gapId;
  }

  /**
   * Explicit user resume. Fails closed if the capacity check does not pass.
   * Returns the new capture epoch id.
   */
  async resume(
    sessionId: SessionId,
    guard: CapacityGuard,
    now: number,
  ): Promise<Result<{ newCaptureEpochId: CaptureEpochId }>> {
    guard.clearWriteFailure();
    const probe = await guard.admit(0);
    if (!probe.admitted) {
      return err(
        businessError(
          probe.reason === "estimate_unavailable"
            ? "CAPACITY_ESTIMATE_UNAVAILABLE"
            : "CAPACITY_HEADROOM_EXHAUSTED",
          `resume denied: capacity admission failed (${probe.reason})`,
          { sessionId },
        ),
      );
    }

    let reservation: Result<{ newCaptureEpochId: CaptureEpochId }>;
    try {
      reservation = await this.reserveResumeAttempt(sessionId, now);
    } catch {
      return err(
        businessError(
          "PERSISTENCE_TRANSACTION_FAILED",
          "storage-pressure resume reservation failed",
          { sessionId },
        ),
      );
    }
    if (!reservation.ok) {
      return reservation;
    }
    const newEpoch = reservation.value.newCaptureEpochId;

    let prepared: Result<PreparedStoragePressureResume | undefined> = ok(undefined);
    if (this.lifecycleHooks !== null) {
      try {
        prepared = await this.lifecycleHooks.onResumed(sessionId, newEpoch);
      } catch {
        prepared = err(
          businessError(
            "DEBUGGER_ATTACH_FAILED",
            "capture pipeline preparation failed during storage-pressure resume",
            { sessionId },
          ),
        );
      }
    }
    if (!prepared.ok) {
      await this.clearResumeAttempt(sessionId, newEpoch).catch(() => undefined);
      return err(prepared.error);
    }
    const preparedResume = prepared.value ?? NOOP_PREPARED_RESUME;

    let committed: Result<{ newCaptureEpochId: CaptureEpochId }>;
    try {
      committed = await this.commitResume(sessionId, newEpoch, now);
    } catch {
      try {
        await preparedResume.rollback();
      } catch {
        // The typed durable failure below remains the primary retry signal.
      }
      return err(
        businessError(
          "PERSISTENCE_TRANSACTION_FAILED",
          "storage-pressure resume commit failed after collector preparation",
          { sessionId },
        ),
      );
    }
    if (!committed.ok) {
      try {
        await preparedResume.rollback();
      } catch {
        return err(
          businessError(
            "PERSISTENCE_TRANSACTION_FAILED",
            "storage-pressure resume rollback failed",
            { sessionId },
          ),
        );
      }
      return committed;
    }

    let activated: Result<void>;
    try {
      activated = await preparedResume.activate();
    } catch {
      activated = err(
        businessError(
          "PERSISTENCE_TRANSACTION_FAILED",
          "capture pipeline activation failed after storage-pressure resume commit",
          { sessionId },
        ),
      );
    }
    if (!activated.ok) {
      try {
        await preparedResume.rollback();
        await this.safeStop(sessionId, "io_write_failed", now);
      } catch {
        return err(
          businessError(
            "PERSISTENCE_TRANSACTION_FAILED",
            "capture pipeline activation rollback failed",
            { sessionId },
          ),
        );
      }
      return err(activated.error);
    }
    this.quiescedSessions.delete(sessionId);
    return committed;
  }

  private reserveResumeAttempt(
    sessionId: SessionId,
    now: number,
  ): Promise<Result<{ newCaptureEpochId: CaptureEpochId }>> {
    return runAtomicWrite(this.db, [STORES.sessions, STORES.sessionControl], async (txn) => {
      const sessionRaw = await getRecord(txn.objectStore(STORES.sessions), sessionId);
      const controlStore = txn.objectStore(STORES.sessionControl);
      const controlRaw = await getRecord(controlStore, sessionId);
      if (sessionRaw === undefined || controlRaw === undefined) {
        return err(businessError("SESSION_NOT_FOUND", `session ${sessionId} not found`));
      }
      const session = sessionRecordSchema.parse(sessionRaw);
      const control = sessionControlRecordSchema.parse(controlRaw);
      const transitionResult = transition(session.lifecycle, "explicit_resume_after_pressure");
      if (transitionResult.outcome !== "transitioned") {
        return err(
          businessError(
            "SESSION_INVALID_TRANSITION",
            `resume invalid from ${session.lifecycle}`,
            { sessionId, state: session.lifecycle },
          ),
        );
      }
      const captureEpochId = control.resumeAttempt?.captureEpochId ?? newCaptureEpochId();
      if (control.resumeAttempt === undefined) {
        controlStore.put(
          sessionControlRecordSchema.parse({
            ...control,
            resumeAttempt: { captureEpochId, reservedAt: now },
          }),
        );
      }
      return ok({ newCaptureEpochId: captureEpochId });
    });
  }

  private commitResume(
    sessionId: SessionId,
    newEpoch: CaptureEpochId,
    now: number,
  ): Promise<Result<{ newCaptureEpochId: CaptureEpochId }>> {
    return runAtomicWrite(
      this.db,
      [STORES.sessions, STORES.sessionControl, STORES.captureGaps],
      async (txn) => {
        const controlStore = txn.objectStore(STORES.sessionControl);
        const sessionsStore = txn.objectStore(STORES.sessions);
        const gapsStore = txn.objectStore(STORES.captureGaps);
        const controlRaw = await getRecord(controlStore, sessionId);
        const sessionRaw = await getRecord(sessionsStore, sessionId);
        if (controlRaw === undefined || sessionRaw === undefined) {
          return err(businessError("SESSION_NOT_FOUND", `session ${sessionId} not found`));
        }
        const control = sessionControlRecordSchema.parse(controlRaw);
        const session = sessionRecordSchema.parse(sessionRaw);
        if (control.resumeAttempt?.captureEpochId !== newEpoch) {
          return err(
            businessError("SESSION_INVALID_TRANSITION", "resume reservation is no longer active", {
              sessionId,
            }),
          );
        }
        const result = transition(session.lifecycle, "explicit_resume_after_pressure");
        if (result.outcome !== "transitioned") {
          return err(
            businessError(
              "SESSION_INVALID_TRANSITION",
              `resume invalid from ${session.lifecycle}`,
              { sessionId, state: session.lifecycle },
            ),
          );
        }
        if (control.pause !== undefined) {
          const gapRaw = await getRecord(gapsStore, control.pause.gapId);
          if (gapRaw !== undefined) {
            const gap = captureGapRecordSchema.parse(gapRaw);
            gapsStore.put(
              captureGapRecordSchema.parse({
                ...gap,
                observedEndedAt: now,
                recovery: {
                  action: "explicit_resume",
                  newCaptureEpochId: newEpoch,
                  recoveredAt: now,
                },
              }),
            );
          }
        }
        const {
          pause: _pause,
          resumeAttempt: _resumeAttempt,
          ...controlWithoutPause
        } = control;
        controlStore.put(
          sessionControlRecordSchema.parse({
            ...controlWithoutPause,
            lifecycle: result.next,
            captureEpochId: newEpoch,
          }),
        );
        sessionsStore.put(
          sessionRecordSchema.parse({
            ...session,
            lifecycle: result.next,
            captureEpochIds: session.captureEpochIds.includes(newEpoch)
              ? session.captureEpochIds
              : [...session.captureEpochIds, newEpoch],
          }),
        );
        return ok({ newCaptureEpochId: newEpoch });
      },
    );
  }

  private clearResumeAttempt(sessionId: SessionId, captureEpochId: CaptureEpochId): Promise<void> {
    return runAtomicWrite(this.db, [STORES.sessionControl], async (txn) => {
      const store = txn.objectStore(STORES.sessionControl);
      const raw = await getRecord(store, sessionId);
      if (raw === undefined) {
        return;
      }
      const control = sessionControlRecordSchema.parse(raw);
      if (control.resumeAttempt?.captureEpochId !== captureEpochId) {
        return;
      }
      const { resumeAttempt: _resumeAttempt, ...controlWithoutAttempt } = control;
      store.put(sessionControlRecordSchema.parse(controlWithoutAttempt));
    });
  }
}

export class StoragePressurePauseError extends Error {
  readonly retryable = true;

  constructor(
    readonly businessError: BusinessError,
    cause?: unknown,
  ) {
    super(businessError.message, cause === undefined ? undefined : { cause });
    this.name = "StoragePressurePauseError";
  }
}

const NOOP_PREPARED_RESUME: PreparedStoragePressureResume = {
  activate: () => Promise.resolve(ok(undefined)),
  rollback: () => Promise.resolve(),
};

const reconcilePausedRuntimeState = async (
  txn: IDBTransaction,
  sessionId: SessionId,
  gapId: GapId,
  now: number,
): Promise<void> => {
  const stepStore = txn.objectStore(STORES.steps);
  const stepRaws = await getAllRecords(stepStore.index(SESSION_INDEX), sessionId);
  for (const raw of stepRaws) {
    const step = storedStepSchema.parse(raw);
    if (step.phase !== "draft") {
      continue;
    }
    const terminal = terminalizePausedDraft(step, gapId, now);
    if (terminal === null) {
      stepStore.delete(step.stepId);
    } else {
      stepStore.put(terminal);
    }
  }

  const inFlightStore = txn.objectStore(STORES.inFlightRequests);
  const requestKeys = await requestToPromise<IDBValidKey[]>(
    inFlightStore.index(SESSION_INDEX).getAllKeys(sessionId),
  );
  for (const requestKey of requestKeys) {
    inFlightStore.delete(requestKey);
  }
};

const terminalizePausedDraft = (
  draft: DraftStep,
  gapId: GapId,
  now: number,
): StoredStep | null => {
  if (draft.candidate) {
    return null;
  }
  if (draft.kind === "user_action" && (draft.action === undefined || draft.domBefore === undefined)) {
    return null;
  }
  if (draft.kind === "system_navigation" && draft.navigation === undefined) {
    return null;
  }
  const terminal: Record<string, unknown> = {
    ...draft,
    phase: "sealed",
    endedAt: now,
    closeReason: "storage_pressure_paused",
    domAfter: { captured: false, reason: "missing_due_to_gap", gapId },
  };
  delete terminal.candidate;
  delete terminal.candidateToken;
  return storedStepSchema.parse(terminal);
};

const newGapId_ = (): GapId => newGapId();
