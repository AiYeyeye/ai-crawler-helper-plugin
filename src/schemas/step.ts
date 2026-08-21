import { z } from "zod";
import {
  candidateTokenSchema,
  captureEpochIdSchema,
  extDocumentIdSchema,
  extFrameIdSchema,
  extTabIdSchema,
  sessionIdSchema,
  stepIdSchema,
} from "../shared/ids";
import { actionRecordSchema, userActionTypeSchema } from "./action";
import { epochMsSchema, schemaVersionSchema } from "./common";
import { domAfterSchema, domCaptureSchema } from "./dom";
import { navigationRecordSchema, systemNavigationTriggerSchema } from "./navigation";

/**
 * Step model (PRD 3.2/3.3, design 5).
 *
 * - `kind` discriminates user_action / system_navigation / system_activity.
 * - `phase` discriminates draft (still converging) vs sealed (export-ready).
 * - Draft steps may lack convergence data; sealed steps MUST carry domAfter,
 *   requestKeys, storageDiff linkage, time range and close reason.
 * - Export only ever accepts sealed steps.
 */

// ---------------------------------------------------------------------------
// Shared base fields
// ---------------------------------------------------------------------------

/** Scope isolation key: sessionId + tabId + documentId + frameId (PRD 3.3). */
export const stepScopeSchema = z
  .object({
    tabId: extTabIdSchema,
    documentId: extDocumentIdSchema,
    frameId: extFrameIdSchema,
  })
  .strict();
export type StepScope = z.infer<typeof stepScopeSchema>;

/** Browser-verifiable evidence accepted by cross-context linkage (design 6.4). */
const browserContextEvidenceBaseFields = {
  sourceStepId: stepIdSchema,
  evidenceId: z.string().min(1),
} as const;

export const browserContextEvidenceSchema = z.discriminatedUnion("evidenceType", [
  z
    .object({
      ...browserContextEvidenceBaseFields,
      evidenceType: z.literal("created_navigation_target"),
    })
    .strict(),
  z
    .object({
      ...browserContextEvidenceBaseFields,
      evidenceType: z.literal("opener_tab_id"),
    })
    .strict(),
  z
    .object({
      ...browserContextEvidenceBaseFields,
      evidenceType: z.literal("confirmed_action_token"),
    })
    .strict(),
  z
    .object({
      ...browserContextEvidenceBaseFields,
      evidenceType: z.literal("parent_frame_navigation"),
    })
    .strict(),
]);
export type BrowserContextEvidence = z.infer<typeof browserContextEvidenceSchema>;

/** Cross-context explicit link (design 6.4) — verified evidence only. */
const explicitContextLinkBaseFields = {
  sourceStepId: stepIdSchema,
  targetStepId: stepIdSchema,
  evidenceId: z.string().min(1),
  confidence: z.literal("verified"),
} as const;

export const explicitContextLinkSchema = z.discriminatedUnion("evidenceType", [
  z
    .object({
      ...explicitContextLinkBaseFields,
      relationType: z.literal("triggered_by_step"),
      evidenceType: z.literal("created_navigation_target"),
    })
    .strict(),
  z
    .object({
      ...explicitContextLinkBaseFields,
      relationType: z.literal("opener_step"),
      evidenceType: z.literal("opener_tab_id"),
    })
    .strict(),
  z
    .object({
      ...explicitContextLinkBaseFields,
      relationType: z.literal("triggered_by_step"),
      evidenceType: z.literal("confirmed_action_token"),
    })
    .strict(),
  z
    .object({
      ...explicitContextLinkBaseFields,
      relationType: z.literal("triggered_by_step"),
      evidenceType: z.literal("parent_frame_navigation"),
    })
    .strict(),
]);
export type ExplicitContextLink = z.infer<typeof explicitContextLinkSchema>;

/**
 * Cross-context resolution result.
 *
 * A verified link requires exactly one browser-verifiable evidence item.
 * Multiple items are never resolved heuristically; missing evidence remains
 * an explicit linkage gap (`unlinked`).
 */
export const contextLinkageSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("verified"),
      link: explicitContextLinkSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("ambiguous"),
      targetStepId: stepIdSchema,
      reason: z.enum(["duplicate_evidence", "conflicting_evidence"]),
      evidence: z.array(browserContextEvidenceSchema).min(2),
    })
    .strict(),
  z
    .object({
      state: z.literal("unlinked"),
      targetStepId: stepIdSchema,
      reason: z.literal("missing_browser_evidence"),
    })
    .strict(),
]);
export type ContextLinkage = z.infer<typeof contextLinkageSchema>;

const stepBaseFields = {
  schemaVersion: schemaVersionSchema,
  stepId: stepIdSchema,
  sessionId: sessionIdSchema,
  captureEpochId: captureEpochIdSchema,
  scope: stepScopeSchema,
  /** Monotonic per-session ordinal assigned at creation. */
  ordinal: z.number().int().nonnegative(),
  startedAt: epochMsSchema,
  /** Verified relation or explicit ambiguous/unlinked linkage result (design 6.4). */
  contextLink: contextLinkageSchema.optional(),
  /** Durable reverse projection for target Steps linked from this source Step. */
  outgoingContextLinks: z.array(explicitContextLinkSchema).optional(),
  /** Review flags: raw facts immutable; note/exclusion live beside them. */
  excluded: z.boolean(),
  note: z.string().optional(),
} as const;

const sealedExtraFields = {
  phase: z.literal("sealed"),
  endedAt: epochMsSchema,
  closeReason: z.enum([
    "network_quiet",
    "max_window_timeout",
    "next_user_action",
    "navigation_started",
    "document_replaced",
    "session_stopping",
    "storage_pressure_paused",
    "candidate_promoted_then_closed",
  ]),
  domAfter: domAfterSchema,
  /** Requests attributed by start (immutable startedInStepId). */
  requestKeys: z.array(z.string()),
  /** Storage diff record ids observed during this step. */
  storageDiffIds: z.array(z.string()),
  /** DOM record ids (mutation batches / captures) linked to this step. */
  domRecordIds: z.array(z.string()),
} as const;

const draftExtraFields = {
  phase: z.literal("draft"),
  /** Facts accumulate through repositories; draft only tracks linkage. */
  requestKeys: z.array(z.string()),
  storageDiffIds: z.array(z.string()),
  domRecordIds: z.array(z.string()),
} as const;

// ---------------------------------------------------------------------------
// Sealed variants
// ---------------------------------------------------------------------------

export const sealedUserActionStepSchema = z
  .object({
    ...stepBaseFields,
    ...sealedExtraFields,
    kind: z.literal("user_action"),
    type: userActionTypeSchema,
    action: actionRecordSchema,
    domBefore: domCaptureSchema,
  })
  .strict();
export type SealedUserActionStep = z.infer<typeof sealedUserActionStepSchema>;

export const sealedSystemNavigationStepSchema = z
  .object({
    ...stepBaseFields,
    ...sealedExtraFields,
    kind: z.literal("system_navigation"),
    type: z.literal("system_navigation"),
    trigger: systemNavigationTriggerSchema,
    navigation: navigationRecordSchema,
  })
  .strict();
export type SealedSystemNavigationStep = z.infer<typeof sealedSystemNavigationStepSchema>;

export const sealedSystemActivityStepSchema = z
  .object({
    ...stepBaseFields,
    ...sealedExtraFields,
    kind: z.literal("system_activity"),
    type: z.literal("system_activity"),
    trigger: z.enum(["background_network", "background_mutation", "background_storage"]),
    backgroundCandidate: z.literal(true),
  })
  .strict();
export type SealedSystemActivityStep = z.infer<typeof sealedSystemActivityStepSchema>;

export const sealedStepSchema = z.discriminatedUnion("kind", [
  sealedUserActionStepSchema,
  sealedSystemNavigationStepSchema,
  sealedSystemActivityStepSchema,
]);
export type SealedStep = z.infer<typeof sealedStepSchema>;

// ---------------------------------------------------------------------------
// Draft variants
// ---------------------------------------------------------------------------

const draftUserActionStepBaseFields = {
  ...stepBaseFields,
  ...draftExtraFields,
  kind: z.literal("user_action"),
  type: userActionTypeSchema,
  /** May be absent while the capture message is still in flight. */
  action: actionRecordSchema.optional(),
  domBefore: domCaptureSchema.optional(),
} as const;

export const draftUserActionStepSchema = z.discriminatedUnion("candidate", [
  z
    .object({
      ...draftUserActionStepBaseFields,
      candidate: z.literal(true),
      candidateToken: candidateTokenSchema,
    })
    .strict(),
  z
    .object({
      ...draftUserActionStepBaseFields,
      candidate: z.literal(false),
    })
    .strict(),
]);
export type DraftUserActionStep = z.infer<typeof draftUserActionStepSchema>;

export const draftSystemNavigationStepSchema = z
  .object({
    ...stepBaseFields,
    ...draftExtraFields,
    candidate: z.boolean(),
    kind: z.literal("system_navigation"),
    type: z.literal("system_navigation"),
    trigger: systemNavigationTriggerSchema,
    navigation: navigationRecordSchema.optional(),
  })
  .strict();
export type DraftSystemNavigationStep = z.infer<typeof draftSystemNavigationStepSchema>;

export const draftSystemActivityStepSchema = z
  .object({
    ...stepBaseFields,
    ...draftExtraFields,
    candidate: z.boolean(),
    kind: z.literal("system_activity"),
    type: z.literal("system_activity"),
    trigger: z.enum(["background_network", "background_mutation", "background_storage"]),
    backgroundCandidate: z.literal(true),
  })
  .strict();
export type DraftSystemActivityStep = z.infer<typeof draftSystemActivityStepSchema>;

export const draftStepSchema = z.union([
  draftUserActionStepSchema,
  draftSystemNavigationStepSchema,
  draftSystemActivityStepSchema,
]);
export type DraftStep = z.infer<typeof draftStepSchema>;

// ---------------------------------------------------------------------------
// Stored step = draft | sealed
// ---------------------------------------------------------------------------

export const storedStepSchema = z.union([draftStepSchema, sealedStepSchema]);
export type StoredStep = z.infer<typeof storedStepSchema>;

export const isSealedStep = (step: StoredStep): step is SealedStep => step.phase === "sealed";
export const isDraftStep = (step: StoredStep): step is DraftStep => step.phase === "draft";
