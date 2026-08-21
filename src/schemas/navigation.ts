import { z } from "zod";
import {
  captureEpochIdSchema,
  extDocumentIdSchema,
  extFrameIdSchema,
  extTabIdSchema,
  navigationRecordIdSchema,
  sessionIdSchema,
  stepIdSchema,
} from "../shared/ids";
import { epochMsSchema, schemaVersionSchema } from "./common";

/**
 * Navigation facts (PRD 4.6, design 8).
 */

export const navigationTypeSchema = z.enum([
  "reload",
  "link",
  "form_submit",
  "history_push",
  "history_replace",
  "hash_change",
  "redirect",
  "back_forward",
  "other",
]);
export type NavigationType = z.infer<typeof navigationTypeSchema>;

export const redirectHopSchema = z
  .object({
    fromUrl: z.string(),
    toUrl: z.string(),
    statusCode: z.number().int().optional(),
    occurredAt: epochMsSchema.optional(),
  })
  .strict();

export const navigationRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    navigationRecordId: navigationRecordIdSchema,
    sessionId: sessionIdSchema,
    /** Step this navigation belongs to (user-triggered) or the system step. */
    stepId: stepIdSchema,
    tabId: extTabIdSchema,
    frameId: extFrameIdSchema,
    beforeUrl: z.string(),
    afterUrl: z.string(),
    title: z.string().optional(),
    /** Extension-space document ids; refresh with same URL still differs here. */
    beforeDocumentId: extDocumentIdSchema.optional(),
    afterDocumentId: extDocumentIdSchema,
    navigationType: navigationTypeSchema,
    redirectChain: z.array(redirectHopSchema),
    committedAt: epochMsSchema,
  })
  .strict();
export type NavigationRecord = z.infer<typeof navigationRecordSchema>;

/** System navigation trigger (design 5). */
export const systemNavigationTriggerSchema = z.enum([
  "initial_reload",
  "auto_redirect",
  "browser_back_forward",
  "browser_reload",
  "script_navigation",
  "unknown_no_evidence",
]);
export type SystemNavigationTrigger = z.infer<typeof systemNavigationTriggerSchema>;

// ---------------------------------------------------------------------------
// Durable browser-context registry (design 8 / PRD 4.10)
// ---------------------------------------------------------------------------

export const sessionTabKey = (sessionId: string, tabId: number): string =>
  JSON.stringify([sessionId, tabId]);

export const documentContextKey = (
  sessionId: string,
  tabId: number,
  frameId: number,
  documentId: string,
): string => JSON.stringify([sessionId, tabId, frameId, documentId]);

const derivedTabEvidenceSchema = z.discriminatedUnion("evidenceType", [
  z
    .object({
      evidenceType: z.literal("created_navigation_target"),
      evidenceId: z.string().min(1),
      sourceTabId: extTabIdSchema,
      sourceFrameId: extFrameIdSchema,
      sourceStepId: stepIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      evidenceType: z.literal("opener_tab_id"),
      evidenceId: z.string().min(1),
      sourceTabId: extTabIdSchema,
      sourceStepId: stepIdSchema.optional(),
    })
    .strict(),
]);
export type DerivedTabEvidence = z.infer<typeof derivedTabEvidenceSchema>;

export const sessionTabRecordSchema = z.discriminatedUnion("kind", [
  z
    .object({
      schemaVersion: schemaVersionSchema,
      tabKey: z.string().min(1),
      sessionId: sessionIdSchema,
      captureEpochId: captureEpochIdSchema,
      tabId: extTabIdSchema,
      kind: z.literal("root"),
      registeredAt: epochMsSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: schemaVersionSchema,
      tabKey: z.string().min(1),
      sessionId: sessionIdSchema,
      captureEpochId: captureEpochIdSchema,
      tabId: extTabIdSchema,
      kind: z.literal("derived"),
      evidence: derivedTabEvidenceSchema,
      registeredAt: epochMsSchema,
    })
    .strict(),
]);
export type SessionTabRecord = z.infer<typeof sessionTabRecordSchema>;

export const documentContextRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    documentKey: z.string().min(1),
    sessionId: sessionIdSchema,
    captureEpochId: captureEpochIdSchema,
    tabId: extTabIdSchema,
    frameId: extFrameIdSchema,
    documentId: extDocumentIdSchema,
    parentDocumentId: extDocumentIdSchema.optional(),
    url: z.string().min(1),
    title: z.string().optional(),
    committedAt: epochMsSchema,
  })
  .strict();
export type DocumentContextRecord = z.infer<typeof documentContextRecordSchema>;
