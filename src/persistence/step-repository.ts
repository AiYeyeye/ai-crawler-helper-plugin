import { SESSION_INDEX, STORES, getAllRecords, getRecord } from "./database";
import {
  storedStepSchema,
  isDraftStep,
  type DraftStep,
  type ExplicitContextLink,
  type StoredStep,
} from "../schemas/step";
import { requestRecordSchema, type RequestRecord } from "../schemas/network";
import { storageDiffRecordSchema, type StorageDiffRecord } from "../schemas/storage";
import type { SessionId, StepId } from "../shared/ids";

/**
 * Read-only step repository. Steps are WRITTEN exclusively through the
 * FactIngestor (step_draft_upsert / step_seal envelopes) so that every write
 * stays inside the per-fact atomic transaction.
 */
export class StepRepository {
  constructor(private readonly db: IDBDatabase) {}

  async getStep(stepId: StepId): Promise<StoredStep | null> {
    const txn = this.db.transaction([STORES.steps], "readonly");
    const raw = await getRecord(txn.objectStore(STORES.steps), stepId);
    return raw === undefined ? null : storedStepSchema.parse(raw);
  }

  async listStepsBySession(sessionId: SessionId): Promise<StoredStep[]> {
    const txn = this.db.transaction([STORES.steps], "readonly");
    const raws = await getAllRecords(
      txn.objectStore(STORES.steps).index(SESSION_INDEX),
      sessionId,
    );
    return raws
      .map((raw) => storedStepSchema.parse(raw))
      .sort((a, b) => a.ordinal - b.ordinal);
  }

  async listOpenDraftSteps(sessionId: SessionId): Promise<DraftStep[]> {
    const steps = await this.listStepsBySession(sessionId);
    return steps.filter(isDraftStep);
  }

  async getOutgoingContextLinks(sourceStepId: StepId): Promise<ExplicitContextLink[]> {
    const source = await this.getStep(sourceStepId);
    return [...(source?.outgoingContextLinks ?? [])];
  }

  /**
   * Step plus the records it links to, for Side Panel detail expansion.
   * Linkage ids that no longer resolve are skipped rather than surfaced as
   * empty placeholders.
   */
  async getStepDetail(stepId: StepId): Promise<{
    step: StoredStep;
    requests: RequestRecord[];
    storageDiffs: StorageDiffRecord[];
  } | null> {
    const step = await this.getStep(stepId);
    if (step === null) {
      return null;
    }
    const txn = this.db.transaction([STORES.requests, STORES.storageDiffs], "readonly");
    const requestStore = txn.objectStore(STORES.requests);
    const diffStore = txn.objectStore(STORES.storageDiffs);

    const requests: RequestRecord[] = [];
    for (const requestKey of step.requestKeys) {
      const raw = await getRecord(requestStore, requestKey);
      if (raw !== undefined) {
        requests.push(requestRecordSchema.parse(raw));
      }
    }
    const storageDiffs: StorageDiffRecord[] = [];
    for (const diffId of step.storageDiffIds) {
      const raw = await getRecord(diffStore, diffId);
      if (raw !== undefined) {
        storageDiffs.push(storageDiffRecordSchema.parse(raw));
      }
    }
    return { step, requests, storageDiffs };
  }
}
