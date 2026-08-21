import { SESSION_INDEX, STORES, getAllRecords, getRecord } from "./database";
import { captureGapRecordSchema, type CaptureGapRecord } from "../schemas/capture-gap";
import type { GapId, SessionId } from "../shared/ids";

/**
 * Read-only CaptureGap repository. Gaps are written through the FactIngestor
 * (capture_gap_open / capture_gap_close envelopes) or by the storage-pressure
 * / recovery flows, which manage their own atomic transactions.
 */
export class CaptureGapRepository {
  constructor(private readonly db: IDBDatabase) {}

  async getGap(gapId: GapId): Promise<CaptureGapRecord | null> {
    const txn = this.db.transaction([STORES.captureGaps], "readonly");
    const raw = await getRecord(txn.objectStore(STORES.captureGaps), gapId);
    return raw === undefined ? null : captureGapRecordSchema.parse(raw);
  }

  async listGapsBySession(sessionId: SessionId): Promise<CaptureGapRecord[]> {
    const txn = this.db.transaction([STORES.captureGaps], "readonly");
    const raws = await getAllRecords(
      txn.objectStore(STORES.captureGaps).index(SESSION_INDEX),
      sessionId,
    );
    return raws
      .map((raw) => captureGapRecordSchema.parse(raw))
      .sort((a, b) => a.observedStartedAt - b.observedStartedAt);
  }
}
