import { z } from "zod";
import { exportJobIdSchema, sessionIdSchema, snapshotIdSchema } from "../shared/ids";
import { epochMsSchema, schemaVersionSchema } from "./common";

/**
 * Export snapshot + job schemas (design 13). Consumed by subtask 07; defined
 * here so the export runner only consumes contracts, never invents tables.
 *
 * - ExportSnapshot is frozen in ONE short transaction (never a long
 *   transaction spanning ZIP generation).
 * - ExportJob is an independent persisted state machine, re-entrant across
 *   offscreen / service-worker restarts, with batch cursors and hash
 *   checkpoints.
 */

export const exportSnapshotRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    snapshotId: snapshotIdSchema,
    sessionId: sessionIdSchema,
    /** Immutable raw-facts revision this snapshot freezes. */
    rawRevision: z.number().int().nonnegative(),
    /** Review revision (notes/exclusions) frozen for this export. */
    reviewRevision: z.number().int().nonnegative(),
    /** Per-store high watermark: only rows <= watermark are exported. */
    storeHighWatermarks: z.record(z.string()),
    objectCounts: z.record(z.number().int().nonnegative()),
    logicalBytes: z.number().int().nonnegative(),
    rootHash: z.string(),
    createdAt: epochMsSchema,
  })
  .strict();
export type ExportSnapshotRecord = z.infer<typeof exportSnapshotRecordSchema>;

export const exportJobStateSchema = z.enum([
  "queued",
  "writing",
  "validating",
  "ready_to_download",
  "downloading",
  "completed",
  "failed",
  "cancelled",
]);
export type ExportJobState = z.infer<typeof exportJobStateSchema>;

export const exportJobRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    jobId: exportJobIdSchema,
    sessionId: sessionIdSchema,
    snapshotId: snapshotIdSchema,
    state: exportJobStateSchema,
    format: z.enum(["zip", "single_json"]),
    sink: z.enum(["file_system_writable", "opfs_downloads_fallback"]),
    /** Resumable progress: current store + key cursor within it. */
    batchCursor: z
      .object({ store: z.string(), lastKey: z.string().optional() })
      .strict()
      .optional(),
    /** Entries fully written + running hash checkpoint for safe retry. */
    completedEntryCount: z.number().int().nonnegative(),
    hashCheckpoint: z.string().optional(),
    failure: z
      .object({ errorCode: z.string(), detail: z.string().optional() })
      .strict()
      .optional(),
    createdAt: epochMsSchema,
    updatedAt: epochMsSchema,
  })
  .strict();
export type ExportJobRecord = z.infer<typeof exportJobRecordSchema>;
