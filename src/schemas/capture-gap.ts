import { z } from "zod";
import {
  attachEpochSchema,
  captureEpochIdSchema,
  cdpFrameIdSchema,
  cdpLoaderIdSchema,
  cdpSessionIdSchema,
  cdpTargetIdSchema,
  extDocumentIdSchema,
  extFrameIdSchema,
  extTabIdSchema,
  gapIdSchema,
  sessionIdSchema,
} from "../shared/ids";
import { epochMsSchema, schemaVersionSchema } from "./common";

/**
 * CaptureGap (PRD 4.1, design 4.1).
 *
 * Non-replayable blind windows (debugger detach, DevTools takeover, attach
 * delay, permission missing, runtime interruption, storage-pressure pause)
 * become structured gaps. A session with gaps is `degraded` but stays
 * inspectable and exportable.
 */

export const captureGapReasonSchema = z.enum([
  "debugger_detached",
  "devtools_takeover_suspected",
  "attach_delay",
  "child_target_enable_delay",
  "permission_missing",
  "runtime_interrupted",
  "storage_pressure_paused",
  "new_tab_attach_delay",
  "related_frame_unsupported",
  "history_bridge_unavailable",
  "closed_shadow_root",
  "other_unrecoverable_window",
]);
export type CaptureGapReason = z.infer<typeof captureGapReasonSchema>;

export const affectedCapabilitySchema = z.enum([
  "user_actions",
  "dom",
  "mutation",
  "navigation",
  "network_metadata",
  "network_bodies",
  "cookies",
  "page_storage",
  "all",
]);
export type AffectedCapability = z.infer<typeof affectedCapabilitySchema>;

/** Scope of a gap: which contexts / collectors are affected. */
export const captureGapScopeSchema = z
  .object({
    sessionId: sessionIdSchema,
    tabId: extTabIdSchema.optional(),
    documentId: extDocumentIdSchema.optional(),
    frameId: extFrameIdSchema.optional(),
    collector: z
      .enum(["content_script", "debugger_network", "navigation", "storage", "all"])
      .optional(),
    /** CDP target scope when the gap is CDP-originated. */
    cdpTarget: z
      .object({
        targetId: cdpTargetIdSchema.optional(),
        sessionId: cdpSessionIdSchema.optional(),
        frameId: cdpFrameIdSchema.optional(),
        loaderId: cdpLoaderIdSchema.optional(),
        attachEpoch: attachEpochSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CaptureGapScope = z.infer<typeof captureGapScopeSchema>;

export const captureGapRecoverySchema = z
  .object({
    action: z.enum([
      "reattached",
      "permission_granted",
      "explicit_resume",
      "session_interrupted",
      "target_destroyed",
      "session_stopped",
      "collector_disconnected",
      "none",
    ]),
    newCaptureEpochId: captureEpochIdSchema.optional(),
    newAttachEpoch: attachEpochSchema.optional(),
    recoveredAt: epochMsSchema.optional(),
  })
  .strict();
export type CaptureGapRecovery = z.infer<typeof captureGapRecoverySchema>;

export const captureGapRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    gapId: gapIdSchema,
    scope: captureGapScopeSchema,
    reason: captureGapReasonSchema,
    observedStartedAt: epochMsSchema,
    /** Open gap: not yet ended. */
    observedEndedAt: epochMsSchema.optional(),
    boundaryConfidence: z.enum(["exact", "estimated"]),
    recoverable: z.boolean(),
    affectedCapabilities: z.array(affectedCapabilitySchema).min(1),
    /** Recovery action + new epoch identifiers, once recovered. */
    recovery: captureGapRecoverySchema.optional(),
    detail: z.string().optional(),
  })
  .strict();
export type CaptureGapRecord = z.infer<typeof captureGapRecordSchema>;

export const isCaptureGapRecord = (value: unknown): value is CaptureGapRecord =>
  captureGapRecordSchema.safeParse(value).success;
