import { z } from "zod";
import {
  candidateTokenSchema,
  captureEpochIdSchema,
  eventIdSchema,
  sessionIdSchema,
} from "../shared/ids";
import { actionRecordSchema } from "./action";
import { epochMsSchema, schemaVersionSchema } from "./common";
import { domAfterSchema, domCaptureSchema, domMutationSchema } from "./dom";
import { stepScopeSchema } from "./step";

/**
 * Raw observations emitted by a Content Script.
 *
 * These are deliberately separate from persisted FactPayloads: only the
 * Service Worker orchestrator may allocate Step ids and session ordinals.
 */
export const contentObservationPayloadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("candidate_started"),
      candidate: z
        .object({
          token: candidateTokenSchema,
          type: z.enum(["input", "hover", "scroll"]),
          startedAt: epochMsSchema,
          domBefore: domCaptureSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("candidate_completed"),
      candidate: z
        .object({
          token: candidateTokenSchema,
          observation: z
            .object({
              action: actionRecordSchema,
              domBefore: domCaptureSchema,
              candidate: z.boolean(),
            })
            .strict(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("candidate_cancelled"),
      candidate: z
        .object({
          token: candidateTokenSchema,
          type: z.enum(["input", "hover", "scroll"]),
          reason: z.enum([
            "pointer_leave",
            "quiet_window",
            "replaced_by_candidate",
            "replaced_by_action",
            "stopped",
          ]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("action_started"),
      observation: z
        .object({
          action: actionRecordSchema,
          domBefore: domCaptureSchema,
          candidate: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("mutation_observed"),
      batch: z
        .object({
          mutations: z.array(domMutationSchema),
          domAfter: domAfterSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("document_replaced"),
      url: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("navigation_observed"),
      navigation: z
        .object({
          action: z.enum(["push", "replace", "hash_change"]),
          beforeUrl: z.string().min(1),
          afterUrl: z.string().min(1),
          title: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type ContentObservationPayload = z.infer<typeof contentObservationPayloadSchema>;

export const historyBridgeMessageSchema = z
  .object({
    source: z.literal("ai-crawler-helper-history-bridge"),
    token: z.string().min(1),
    action: z.enum(["push", "replace", "hash_change"]),
    beforeUrl: z.string().min(1),
    afterUrl: z.string().min(1),
    occurredAt: epochMsSchema,
  })
  .strict();
export type HistoryBridgeMessage = z.infer<typeof historyBridgeMessageSchema>;

export const contentObservationEnvelopeSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    eventId: eventIdSchema,
    sourceSeq: z.number().int().nonnegative(),
    sessionId: sessionIdSchema,
    captureEpochId: captureEpochIdSchema,
    /** Echoed from an authenticated handshake; verified against MessageSender. */
    scope: stepScopeSchema,
    sourceTimestamp: epochMsSchema,
    payload: contentObservationPayloadSchema,
  })
  .strict();
export type ContentObservationEnvelope = z.infer<typeof contentObservationEnvelopeSchema>;
