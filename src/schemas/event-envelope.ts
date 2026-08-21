import { z } from "zod";
import {
  candidateTokenSchema,
  eventIdSchema,
  extDocumentIdSchema,
  extFrameIdSchema,
  extTabIdSchema,
  gapIdSchema,
  sessionIdSchema,
  stepIdSchema,
} from "../shared/ids";
import { epochMsSchema, schemaVersionSchema } from "./common";
import { captureGapRecordSchema, captureGapRecoverySchema } from "./capture-gap";
import { domRecordSchema } from "./dom";
import { navigationRecordSchema } from "./navigation";
import { networkStreamMessageRecordSchema, requestRecordSchema } from "./network";
import { storageDiffRecordSchema, storageSnapshotRecordSchema } from "./storage";
import { draftStepSchema, sealedStepSchema } from "./step";

/**
 * Versioned EventEnvelope (design 4.1).
 *
 * Every fact entering the service worker — whether from a content script, the
 * UI, or an internal collector (CDP recorders wrap their facts in envelopes
 * too) — travels in an envelope. The envelope is committed to the durable
 * inbox in the SAME transaction as the fact; the sender is ACKed only after
 * that transaction completes, and retains + replays unacknowledged envelopes
 * idempotently (eventId is the dedupe key).
 */

// ---------------------------------------------------------------------------
// Fact payload union — one variant per persisted fact type
// ---------------------------------------------------------------------------

export const factPayloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("observation_checkpoint"),
      observationEventId: eventIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal("step_draft_upsert"), step: draftStepSchema }).strict(),
  z
    .object({
      kind: z.literal("step_draft_delete"),
      stepId: stepIdSchema,
      candidateToken: candidateTokenSchema,
    })
    .strict(),
  z.object({ kind: z.literal("step_seal"), step: sealedStepSchema }).strict(),
  /**
   * Review-layer update (PRD 4.15). Touches ONLY `excluded` / `note`; every raw
   * fact on the step stays byte-identical. Exclusion is a flag, never a delete.
   */
  z
    .object({
      kind: z.literal("step_review_update"),
      stepId: stepIdSchema,
      excluded: z.boolean().optional(),
      /** `null` clears the note; omitted leaves it unchanged. */
      note: z.string().nullable().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("dom_record"), record: domRecordSchema }).strict(),
  z.object({ kind: z.literal("navigation_record"), record: navigationRecordSchema }).strict(),
  z.object({ kind: z.literal("request_metadata"), record: requestRecordSchema }).strict(),
  z
    .object({
      kind: z.literal("network_stream_message"),
      record: networkStreamMessageRecordSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("response_body"),
      requestKey: z.string().min(1),
      bodyRef: z.string().min(1),
      /** Decoded text body; soft-budget admission decided at commit time. */
      text: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal("storage_snapshot"), record: storageSnapshotRecordSchema }).strict(),
  z.object({ kind: z.literal("storage_diff"), record: storageDiffRecordSchema }).strict(),
  z.object({ kind: z.literal("capture_gap_open"), record: captureGapRecordSchema }).strict(),
  z
    .object({
      kind: z.literal("capture_gap_close"),
      gapId: gapIdSchema,
      observedEndedAt: epochMsSchema,
      recovery: captureGapRecoverySchema.optional(),
    })
    .strict(),
]);
export type FactPayload = z.infer<typeof factPayloadSchema>;

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export const envelopeSourceSchema = z.enum(["content_script", "service_worker", "ui"]);
export type EnvelopeSource = z.infer<typeof envelopeSourceSchema>;

export const envelopeScopeSchema = z
  .object({
    tabId: extTabIdSchema.optional(),
    documentId: extDocumentIdSchema.optional(),
    frameId: extFrameIdSchema.optional(),
  })
  .strict();
export type EnvelopeScope = z.infer<typeof envelopeScopeSchema>;

export const eventEnvelopeSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    eventId: eventIdSchema,
    source: envelopeSourceSchema,
    /** Monotonic per source scope; used for ordering and gap inference. */
    sourceSeq: z.number().int().nonnegative(),
    sessionId: sessionIdSchema,
    scope: envelopeScopeSchema,
    sourceTimestamp: epochMsSchema,
    payload: factPayloadSchema,
  })
  .strict();
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/** Key under which lastCommittedSeqBySource tracks this envelope's source. */
export const envelopeSourceKey = (envelope: EventEnvelope): string =>
  [
    envelope.source,
    envelope.scope.tabId === undefined ? "-" : String(envelope.scope.tabId),
    envelope.scope.documentId ?? "-",
    envelope.scope.frameId === undefined ? "-" : String(envelope.scope.frameId),
  ].join(":");

// ---------------------------------------------------------------------------
// Durable inbox entry (same-transaction companion of the fact)
// ---------------------------------------------------------------------------

export const inboxEntrySchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    eventId: eventIdSchema,
    sessionId: sessionIdSchema,
    sourceKey: z.string(),
    sourceSeq: z.number().int().nonnegative(),
    payloadKind: z.string(),
    receivedAt: epochMsSchema,
    committedAt: epochMsSchema,
    /** Store + primary key the fact landed in (audit / replay diagnosis). */
    targetStore: z.string(),
    targetKey: z.string(),
  })
  .strict();
export type InboxEntry = z.infer<typeof inboxEntrySchema>;

// ---------------------------------------------------------------------------
// ACK — returned to the sender only after the transaction committed
// ---------------------------------------------------------------------------

export const envelopeAckSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("committed"),
      eventId: eventIdSchema,
      committedBytes: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ status: z.literal("duplicate"), eventId: eventIdSchema }).strict(),
  z
    .object({
      status: z.literal("rejected"),
      eventId: eventIdSchema,
      errorCode: z.string(),
      /** Sender must retain and replay later iff true. */
      retryable: z.boolean(),
    })
    .strict(),
]);
export type EnvelopeAck = z.infer<typeof envelopeAckSchema>;
