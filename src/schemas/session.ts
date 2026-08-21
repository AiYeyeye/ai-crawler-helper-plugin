import { z } from "zod";
import {
  captureEpochIdSchema,
  eventIdSchema,
  extTabIdSchema,
  gapIdSchema,
  sessionIdSchema,
  stepIdSchema,
} from "../shared/ids";
import { captureQualitySchema, epochMsSchema, schemaVersionSchema } from "./common";

/**
 * Session records + durable session control (PRD 4.1/4.12/4.13, design 4/12).
 */

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export const sessionLifecycleSchema = z.enum([
  "idle",
  "starting",
  "recording",
  "stopping",
  "completed",
  "interrupted",
  "paused_storage_pressure",
  "deleted",
]);
export type SessionLifecycle = z.infer<typeof sessionLifecycleSchema>;

// ---------------------------------------------------------------------------
// Session configuration (user-adjustable; hard guard is NOT disableable)
// ---------------------------------------------------------------------------

export const sessionConfigSchema = z
  .object({
    /** Response-body soft budget for the whole session. Bytes, actual UTF-8. */
    responseBodySoftBudgetBytes: z.number().int().positive(),
    /** Per-body max text size. Bytes, actual UTF-8. */
    responseBodyMaxBytes: z.number().int().positive(),
    hoverDwellThresholdMs: z.number().int().positive(),
    networkQuietWindowMs: z.number().int().positive(),
    stepMaxWindowMs: z.number().int().positive(),
    /** User request-filter rules (evaluated last; rule id recorded). */
    userFilterRules: z.array(
      z
        .object({
          ruleId: z.string(),
          kind: z.enum(["domain", "url_regex", "method", "content_type"]),
          pattern: z.string(),
        })
        .strict(),
    ),
    extraCookieDomains: z.array(z.string()),
  })
  .strict();
export type SessionConfig = z.infer<typeof sessionConfigSchema>;

// ---------------------------------------------------------------------------
// Session record
// ---------------------------------------------------------------------------

export const sessionRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    sessionId: sessionIdSchema,
    lifecycle: sessionLifecycleSchema,
    /** Orthogonal to lifecycle: degraded iff any CaptureGap exists. */
    captureQuality: captureQualitySchema,
    startMode: z.enum(["no_reload", "reload"]),
    originUrl: z.string(),
    originTitle: z.string().optional(),
    rootTabId: extTabIdSchema,
    startedAt: epochMsSchema,
    /** Durable start of the late-response stop window; survives MV3 restart. */
    stopRequestedAt: epochMsSchema.optional(),
    stoppedAt: epochMsSchema.optional(),
    config: sessionConfigSchema,
    /** All capture epochs in order; last entry is current. */
    captureEpochIds: z.array(captureEpochIdSchema).min(1),
    /** Copied-from linkage when a completed session is duplicated (PRD 4.1). */
    copiedFromSessionId: sessionIdSchema.optional(),
  })
  .strict();
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

// ---------------------------------------------------------------------------
// Session control — atomically co-committed with every fact (design 12/12.1)
// ---------------------------------------------------------------------------

export const sessionCountersSchema = z
  .object({
    /** All committed fact records, logical UTF-8 JSON bytes. */
    totalLogicalBytes: z.number().int().nonnegative(),
    /** Response-body text bytes only (soft-budget basis). */
    responseBodyLogicalBytes: z.number().int().nonnegative(),
    factCount: z.number().int().nonnegative(),
  })
  .strict();
export type SessionCounters = z.infer<typeof sessionCountersSchema>;

export const capacityCheckSummarySchema = z
  .object({
    checkedAt: epochMsSchema,
    quota: z.number().nonnegative().optional(),
    usage: z.number().nonnegative().optional(),
    outcome: z.enum(["admitted", "rejected", "estimate_unavailable"]),
  })
  .strict();
export type CapacityCheckSummary = z.infer<typeof capacityCheckSummarySchema>;

export const sessionControlRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    sessionId: sessionIdSchema,
    captureEpochId: captureEpochIdSchema,
    lifecycle: sessionLifecycleSchema,
    /**
     * Clean-stop marker for crash recovery: false for the whole life of a
     * recording epoch; set true only by an orderly stop. On startup, a control
     * record with active lifecycle and cleanStop=false is an unclean epoch.
     */
    cleanStop: z.boolean(),
    /** Highest committed sourceSeq per source scope key. */
    lastCommittedSeqBySource: z.record(z.number().int().nonnegative()),
    lastCommittedEventId: eventIdSchema.optional(),
    lastCommittedAt: epochMsSchema.optional(),
    openStepIds: z.array(stepIdSchema),
    counters: sessionCountersSchema,
    lastCapacityCheck: capacityCheckSummarySchema.optional(),
    /** Present while paused for storage pressure. */
    pause: z
      .object({
        reason: z.enum(["headroom_exhausted", "quota_exceeded_error", "io_write_failed"]),
        pausedAt: epochMsSchema,
        gapId: gapIdSchema,
      })
      .strict()
      .optional(),
    /** Reserved epoch while resume prepares collectors with the fact gate closed. */
    resumeAttempt: z
      .object({
        captureEpochId: captureEpochIdSchema,
        reservedAt: epochMsSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
export type SessionControlRecord = z.infer<typeof sessionControlRecordSchema>;

/** Minimal best-effort stop record mirrored to chrome.storage.local. */
export const minimalStopRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    sessionId: sessionIdSchema,
    captureEpochId: captureEpochIdSchema,
    state: sessionLifecycleSchema,
    reasonCode: z.string(),
    pausedAt: epochMsSchema,
    lastCommittedAt: epochMsSchema.optional(),
  })
  .strict();
export type MinimalStopRecord = z.infer<typeof minimalStopRecordSchema>;
