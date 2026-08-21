import { SESSION_INDEX, STORES, getAllRecords, getRecord } from "./database";
import {
  exportJobRecordSchema,
  exportSnapshotRecordSchema,
  type ExportJobRecord,
  type ExportSnapshotRecord,
} from "../schemas/export";
import { isSealedStep } from "../schemas/step";
import { businessError } from "../shared/errors";
import {
  newExportJobId,
  newSnapshotId,
  type ExportJobId,
  type SessionId,
  type SnapshotId,
} from "../shared/ids";
import { collectSessionExportData } from "./export-readback";
import { SCHEMA_VERSION } from "../schemas/common";

/**
 * ExportJob and ExportSnapshot persistence repository (design 12 & 13).
 */

export const createExportSnapshot = async (
  db: IDBDatabase,
  sessionId: SessionId,
): Promise<ExportSnapshotRecord> => {
  const data = await collectSessionExportData(db, sessionId);

  // Short transaction to get watermark and counts
  const snapshotId = newSnapshotId();
  const now = Date.now();

  const objectCounts: Record<string, number> = {
    steps: data.steps.length,
    domRecords: data.domRecords.length,
    navigations: data.navigations.length,
    requests: data.requests.length,
    responseBodies: data.responseBodies.length,
    storageSnapshots: data.storageSnapshots.length,
    storageDiffs: data.storageDiffs.length,
    captureGaps: data.captureGaps.length,
  };

  let logicalBytes = 0;
  for (const b of data.responseBodies) {
    logicalBytes += b.byteLength;
  }

  const rawRevision = data.control.counters.factCount;

  // Review revision is tracked directly on steps
  let reviewRevision = 0;
  for (const s of data.steps) {
    if (isSealedStep(s) && (s.note !== undefined || s.excluded)) {
      reviewRevision++;
    }
  }

  const snapshot: ExportSnapshotRecord = {
    schemaVersion: SCHEMA_VERSION,
    snapshotId,
    sessionId,
    rawRevision,
    reviewRevision,
    storeHighWatermarks: {
      steps: data.steps[data.steps.length - 1]?.stepId ?? "",
      requests: data.requests[data.requests.length - 1]?.requestKey ?? "",
    },
    objectCounts,
    logicalBytes,
    rootHash: `hash-${sessionId}-${String(rawRevision)}-${String(reviewRevision)}`,
    createdAt: now,
  };

  const parsed = exportSnapshotRecordSchema.parse(snapshot);
  const txn = db.transaction([STORES.exportSnapshots], "readwrite");
  txn.objectStore(STORES.exportSnapshots).put(parsed);
  return parsed;
};

export const getExportSnapshot = async (
  db: IDBDatabase,
  snapshotId: SnapshotId,
): Promise<ExportSnapshotRecord | undefined> => {
  const txn = db.transaction([STORES.exportSnapshots], "readonly");
  const raw = await getRecord(txn.objectStore(STORES.exportSnapshots), snapshotId);
  if (raw === undefined) {
    return undefined;
  }
  return exportSnapshotRecordSchema.parse(raw);
};

export const createExportJob = (
  db: IDBDatabase,
  sessionId: SessionId,
  snapshotId: SnapshotId,
  format: "zip" | "single_json",
  sink: "file_system_writable" | "opfs_downloads_fallback",
): Promise<ExportJobRecord> => {
  const now = Date.now();
  const job: ExportJobRecord = {
    schemaVersion: SCHEMA_VERSION,
    jobId: newExportJobId(),
    sessionId,
    snapshotId,
    state: "queued",
    format,
    sink,
    completedEntryCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  const parsed = exportJobRecordSchema.parse(job);
  const txn = db.transaction([STORES.exportJobs], "readwrite");
  txn.objectStore(STORES.exportJobs).put(parsed);
  return Promise.resolve(parsed);
};

export const getExportJob = async (
  db: IDBDatabase,
  jobId: ExportJobId,
): Promise<ExportJobRecord | undefined> => {
  const txn = db.transaction([STORES.exportJobs], "readonly");
  const raw = await getRecord(txn.objectStore(STORES.exportJobs), jobId);
  if (raw === undefined) {
    return undefined;
  }
  return exportJobRecordSchema.parse(raw);
};

export const updateExportJob = async (
  db: IDBDatabase,
  jobId: ExportJobId,
  changes: Partial<ExportJobRecord>,
): Promise<ExportJobRecord> => {
  const existing = await getExportJob(db, jobId);
  if (!existing) {
    const err = businessError("SESSION_NOT_FOUND", `export job ${jobId} not found`);
    throw new Error(err.message);
  }

  const updated: ExportJobRecord = {
    ...existing,
    ...changes,
    updatedAt: Date.now(),
  };

  const parsed = exportJobRecordSchema.parse(updated);
  const txn = db.transaction([STORES.exportJobs], "readwrite");
  txn.objectStore(STORES.exportJobs).put(parsed);
  return parsed;
};

export const listExportJobsBySession = async (
  db: IDBDatabase,
  sessionId: SessionId,
): Promise<ExportJobRecord[]> => {
  const txn = db.transaction([STORES.exportJobs], "readonly");
  const store = txn.objectStore(STORES.exportJobs);
  const index = store.index(SESSION_INDEX);
  const raws = await getAllRecords(index, sessionId);
  return raws.map((r) => exportJobRecordSchema.parse(r));
};
