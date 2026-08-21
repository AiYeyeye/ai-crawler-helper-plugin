import { STORES, getAllRecords, getRecord, runAtomicWrite } from "./database";
import {
  sessionControlRecordSchema,
  sessionRecordSchema,
} from "../schemas/session";
import { captureGapRecordSchema, type CaptureGapRecord } from "../schemas/capture-gap";
import { SCHEMA_VERSION } from "../schemas/common";
import { newGapId, type SessionId } from "../shared/ids";
import { isUncleanActiveState, transition } from "../core/session-state-machine";

/**
 * Startup recovery (PRD 4.12, design 12.1).
 *
 * The service worker (or the whole browser) can die at any moment. Because
 * every fact transaction also maintains `sessionControl`, recovery never
 * depends on a shutdown record having been written:
 *
 *  - A control record in starting/recording/stopping with `cleanStop=false`
 *    is an UNCLEAN epoch → the session becomes `interrupted`, and the window
 *    from `lastCommittedAt` (or session start) to now becomes a CaptureGap
 *    with estimated boundary confidence.
 *  - `paused_storage_pressure` survives as-is (data stays inspectable).
 *  - Committed facts are never touched; recording never silently resumes —
 *    the user must explicitly continue or stop+export.
 */

export interface RecoveredSession {
  sessionId: SessionId;
  previousLifecycle: string;
  gapId: string;
  openStepIds: readonly string[];
}

export const recoverOnStartup = async (
  db: IDBDatabase,
  now: number,
): Promise<RecoveredSession[]> => {
  const readTxn = db.transaction([STORES.sessionControl], "readonly");
  const controlsRaw = await getAllRecords(readTxn.objectStore(STORES.sessionControl));
  const controls = controlsRaw.map((raw) => sessionControlRecordSchema.parse(raw));

  const recovered: RecoveredSession[] = [];
  for (const control of controls) {
    if (control.resumeAttempt !== undefined) {
      await runAtomicWrite(db, [STORES.sessionControl], async (txn) => {
        const controlStore = txn.objectStore(STORES.sessionControl);
        const freshControlRaw = await getRecord(controlStore, control.sessionId);
        if (freshControlRaw === undefined) {
          return;
        }
        const freshControl = sessionControlRecordSchema.parse(freshControlRaw);
        if (freshControl.resumeAttempt === undefined) {
          return;
        }
        delete freshControl.resumeAttempt;
        controlStore.put(sessionControlRecordSchema.parse(freshControl));
      });
    }
    // `stopping` is an intentional durable state. The Service Worker resumes
    // its remaining late-response window from SessionRecord.stopRequestedAt.
    if (control.lifecycle === "stopping") {
      continue;
    }
    if (!isUncleanActiveState(control.lifecycle) || control.cleanStop) {
      continue;
    }
    const result = await runAtomicWrite(
      db,
      [STORES.sessions, STORES.sessionControl, STORES.captureGaps],
      async (txn) => {
        const controlStore = txn.objectStore(STORES.sessionControl);
        const sessionsStore = txn.objectStore(STORES.sessions);
        const freshControlRaw = await getRecord(controlStore, control.sessionId);
        const sessionRaw = await getRecord(sessionsStore, control.sessionId);
        if (freshControlRaw === undefined || sessionRaw === undefined) {
          return null;
        }
        const freshControl = sessionControlRecordSchema.parse(freshControlRaw);
        const session = sessionRecordSchema.parse(sessionRaw);
        if (freshControl.lifecycle === "stopping") {
          return null;
        }
        if (!isUncleanActiveState(freshControl.lifecycle) || freshControl.cleanStop) {
          return null; // idempotent: another pass already recovered it
        }

        const transitionResult = transition(session.lifecycle, "runtime_interrupted");
        if (transitionResult.outcome !== "transitioned") {
          return null;
        }

        const gapId = newGapId();
        const gap: CaptureGapRecord = captureGapRecordSchema.parse({
          schemaVersion: SCHEMA_VERSION,
          gapId,
          scope: { sessionId: freshControl.sessionId, collector: "all" },
          reason: "runtime_interrupted",
          observedStartedAt: freshControl.lastCommittedAt ?? session.startedAt,
          observedEndedAt: now,
          boundaryConfidence: "estimated",
          recoverable: true,
          affectedCapabilities: ["all"],
          recovery: { action: "session_interrupted", recoveredAt: now },
        });
        txn.objectStore(STORES.captureGaps).put(gap);
        controlStore.put(
          sessionControlRecordSchema.parse({
            ...freshControl,
            lifecycle: transitionResult.next,
          }),
        );
        sessionsStore.put(
          sessionRecordSchema.parse({
            ...session,
            lifecycle: transitionResult.next,
            captureQuality: "degraded",
          }),
        );
        return {
          sessionId: freshControl.sessionId,
          previousLifecycle: control.lifecycle,
          gapId: gapId as string,
          openStepIds: freshControl.openStepIds,
        } satisfies RecoveredSession;
      },
    );
    if (result !== null) {
      recovered.push(result);
    }
  }
  return recovered;
};
