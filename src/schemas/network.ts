import { z } from "zod";
import {
  attachEpochSchema,
  captureEpochIdSchema,
  cdpFrameIdSchema,
  cdpLoaderIdSchema,
  cdpRequestIdSchema,
  cdpSessionIdSchema,
  cdpTargetIdSchema,
  extDocumentIdSchema,
  extFrameIdSchema,
  extTabIdSchema,
  gapIdSchema,
  eventIdSchema,
  sessionIdSchema,
  stepIdSchema,
} from "../shared/ids";
import { epochMsSchema, identifierMappingStateSchema, schemaVersionSchema } from "./common";
import { stepScopeSchema } from "./step";

/**
 * Network facts (PRD 4.7, design 9).
 *
 * Persisted primary key: `(tabId, childSessionId?, attachEpoch, requestId,
 * redirectHop)` — serialized into `requestKey` for IndexedDB. CDP identifiers
 * are branded and never compared to extension identifiers directly; they are
 * related only through `identifierMapping` with state
 * `confirmed | ambiguous | unmapped`.
 */

// ---------------------------------------------------------------------------
// Composite request key
// ---------------------------------------------------------------------------

export const requestKeyPartsSchema = z
  .object({
    tabId: extTabIdSchema,
    childSessionId: cdpSessionIdSchema.optional(),
    attachEpoch: attachEpochSchema,
    requestId: cdpRequestIdSchema,
    redirectHop: z.number().int().nonnegative(),
  })
  .strict();
export type RequestKeyParts = z.infer<typeof requestKeyPartsSchema>;

/** Deterministic serialization of the composite key (IndexedDB primary key). */
export const buildRequestKey = (parts: RequestKeyParts): string =>
  [
    String(parts.tabId),
    parts.childSessionId ?? "-",
    String(parts.attachEpoch),
    parts.requestId,
    String(parts.redirectHop),
  ].join("|");

// ---------------------------------------------------------------------------
// Ext <-> CDP identifier mapping (versioned; the ONLY legal bridge)
// ---------------------------------------------------------------------------

export const identifierMappingSchema = z
  .object({
    state: identifierMappingStateSchema,
    ext: z
      .object({
        tabId: extTabIdSchema,
        frameId: extFrameIdSchema.optional(),
        documentId: extDocumentIdSchema.optional(),
      })
      .strict()
      .optional(),
    cdp: z
      .object({
        targetId: cdpTargetIdSchema.optional(),
        sessionId: cdpSessionIdSchema.optional(),
        frameId: cdpFrameIdSchema.optional(),
        loaderId: cdpLoaderIdSchema.optional(),
      })
      .strict()
      .optional(),
    /** Evidence used to confirm the mapping (navigation commit etc.). */
    evidence: z.string().optional(),
    mappedAt: epochMsSchema.optional(),
  })
  .strict();
export type IdentifierMapping = z.infer<typeof identifierMappingSchema>;

export const identifierMappingKeyPartsSchema = z
  .object({
    sessionId: sessionIdSchema,
    tabId: extTabIdSchema,
    childSessionId: cdpSessionIdSchema.optional(),
    attachEpoch: attachEpochSchema,
    frameId: cdpFrameIdSchema.optional(),
    loaderId: cdpLoaderIdSchema.optional(),
  })
  .strict();
export type IdentifierMappingKeyParts = z.infer<typeof identifierMappingKeyPartsSchema>;

export const buildIdentifierMappingKey = (parts: IdentifierMappingKeyParts): string =>
  JSON.stringify([
    parts.sessionId,
    parts.tabId,
    parts.childSessionId ?? null,
    parts.attachEpoch,
    parts.frameId ?? null,
    parts.loaderId ?? null,
  ]);

export const identifierMappingRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    mappingKey: z.string().min(1),
    sessionId: sessionIdSchema,
    captureEpochId: captureEpochIdSchema,
    tabId: extTabIdSchema,
    childSessionId: cdpSessionIdSchema.optional(),
    attachEpoch: attachEpochSchema,
    frameId: cdpFrameIdSchema.optional(),
    loaderId: cdpLoaderIdSchema.optional(),
    mapping: identifierMappingSchema,
    recordedAt: epochMsSchema,
  })
  .strict();
export type IdentifierMappingRecord = z.infer<typeof identifierMappingRecordSchema>;

// ---------------------------------------------------------------------------
// Response body result — discriminated union (never "" for a failed read)
// ---------------------------------------------------------------------------

export const responseBodyResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("captured"),
      /** Key into the responseBodies store; body text stored separately. */
      bodyRef: z.string().min(1),
      byteLength: z.number().int().nonnegative(),
      encoding: z.enum(["utf8", "base64_decoded_text"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("filtered"),
      ruleId: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("too_large"),
      byteLength: z.number().int().nonnegative(),
      limitBytes: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("binary_metadata_only"),
      byteLength: z.number().int().nonnegative().optional(),
      mimeType: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason: z.enum([
        "cdp_get_response_body_failed",
        "session_body_soft_budget_reached",
        "target_detached_before_read",
        "other",
      ]),
      detail: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("missing_due_to_gap"),
      gapId: gapIdSchema,
    })
    .strict(),
]);
export type ResponseBodyResult = z.infer<typeof responseBodyResultSchema>;

// ---------------------------------------------------------------------------
// Request record (metadata; bodies live in responseBodies store)
// ---------------------------------------------------------------------------

export const httpHeadersSchema = z.array(
  z.object({ name: z.string(), value: z.string() }).strict(),
);
export type HttpHeaders = z.infer<typeof httpHeadersSchema>;

export const requestRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    requestKey: z.string().min(1),
    keyParts: requestKeyPartsSchema,
    sessionId: sessionIdSchema,
    captureEpochId: captureEpochIdSchema,
    scope: stepScopeSchema,
    /** Immutable: step active in the request's scope at requestWillBeSent. */
    startedInStepId: stepIdSchema,
    /** False once a long-lived stream is established and no longer delays Step convergence. */
    blocksStep: z.boolean().optional(),
    /** Timeline aid only; never changes attribution (design 6.3). */
    completedDuringStepId: stepIdSchema.optional(),
    identifierMapping: identifierMappingSchema,
    method: z.string(),
    url: z.string(),
    queryParams: z.array(z.object({ name: z.string(), value: z.string() }).strict()),
    requestHeaders: httpHeadersSchema,
    requestExtraInfoState: z.enum(["expected", "received", "not_expected", "unknown"]).optional(),
    requestBody: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("text"), text: z.string() }).strict(),
        z.object({ kind: z.literal("binary_metadata_only"), byteLength: z.number().int() }).strict(),
        z.object({ kind: z.literal("none") }).strict(),
        z.object({ kind: z.literal("unavailable"), reason: z.string() }).strict(),
      ])
      .optional(),
    statusCode: z.number().int().optional(),
    responseHeaders: httpHeadersSchema.optional(),
    responseExtraInfoState: z.enum(["expected", "received", "not_expected", "unknown"]).optional(),
    responseMimeType: z.string().optional(),
    responseBody: responseBodyResultSchema.optional(),
    resourceType: z.string().optional(),
    /** GraphQL classification is best-effort; failure never drops the request. */
    graphql: z
      .object({ operationName: z.string().optional(), operationType: z.string().optional() })
      .strict()
      .optional(),
    preflight: z
      .discriminatedUnion("state", [
        z.object({ state: z.literal("none") }).strict(),
        z
          .object({
            state: z.literal("occurred"),
            requestKey: z.string().min(1),
            method: z.literal("OPTIONS"),
            url: z.string(),
            statusCode: z.number().int().optional(),
          })
          .strict(),
        z
          .object({
            state: z.literal("ambiguous"),
            referencedRequestId: cdpRequestIdSchema.optional(),
            reason: z.enum([
              "missing_request_reference",
              "referenced_request_unavailable",
              "referenced_request_not_options",
            ]),
          })
          .strict(),
      ])
      .optional(),
    initiatorStack: z.string().optional(),
    redirectChainUrls: z.array(z.string()).optional(),
    startedAt: epochMsSchema,
    /** Correlates subsequent CDP monotonic timestamps after worker hydration. */
    cdpClockOffsetMs: z.number().optional(),
    completedAt: epochMsSchema.optional(),
    durationMs: z.number().nonnegative().optional(),
    failure: z.object({ errorText: z.string(), canceled: z.boolean() }).strict().optional(),
  })
  .strict();
export type RequestRecord = z.infer<typeof requestRecordSchema>;

// ---------------------------------------------------------------------------
// Durable incomplete-request projection (MV3 worker hydration)
// ---------------------------------------------------------------------------

export const inFlightRequestRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    requestKey: z.string().min(1),
    keyParts: requestKeyPartsSchema,
    sessionId: sessionIdSchema,
    captureEpochId: captureEpochIdSchema,
    scope: stepScopeSchema,
    startedInStepId: stepIdSchema,
    blocksStep: z.boolean().default(true),
    phase: z.enum(["request_started", "response_received"]),
    startedAt: epochMsSchema,
    cdpClockOffsetMs: z.number().optional(),
    updatedAt: epochMsSchema,
  })
  .strict();
export type InFlightRequestRecord = z.infer<typeof inFlightRequestRecordSchema>;

export const debuggerAttachEpochStateSchema = z
  .object({
    key: z.string().min(1),
    sessionId: sessionIdSchema,
    tabId: extTabIdSchema,
    lastAttachEpoch: attachEpochSchema,
    updatedAt: epochMsSchema,
  })
  .strict();
export type DebuggerAttachEpochState = z.infer<typeof debuggerAttachEpochStateSchema>;

// ---------------------------------------------------------------------------
// Response body row (separate store; large text kept out of metadata rows)
// ---------------------------------------------------------------------------

export const responseBodyRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    /** Same value as the owning request's responseBody.bodyRef. */
    bodyRef: z.string().min(1),
    requestKey: z.string().min(1),
    sessionId: sessionIdSchema,
    text: z.string(),
    byteLength: z.number().int().nonnegative(),
    recordedAt: epochMsSchema,
  })
  .strict();
export type ResponseBodyRecord = z.infer<typeof responseBodyRecordSchema>;

// ---------------------------------------------------------------------------
// Long-lived stream messages (WebSocket / Server-Sent Events)
// ---------------------------------------------------------------------------

const networkStreamMessageBaseShape = {
  schemaVersion: schemaVersionSchema,
  messageId: eventIdSchema,
  requestKey: z.string().min(1),
  sessionId: sessionIdSchema,
  startedInStepId: stepIdSchema,
  observedDuringStepId: stepIdSchema,
  observedAt: epochMsSchema,
};

export const webSocketMessageRecordSchema = z
  .object({
    ...networkStreamMessageBaseShape,
    kind: z.literal("websocket"),
    direction: z.enum(["sent", "received"]),
    payload: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("text"),
          text: z.string(),
          byteLength: z.number().int().nonnegative(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("binary_metadata_only"),
          opcode: z.number().int().nonnegative(),
          byteLength: z.number().int().nonnegative(),
        })
        .strict(),
    ]),
  })
  .strict();
export type WebSocketMessageRecord = z.infer<typeof webSocketMessageRecordSchema>;

export const serverSentEventRecordSchema = z
  .object({
    ...networkStreamMessageBaseShape,
    kind: z.literal("sse"),
    eventName: z.string(),
    serverEventId: z.string(),
    data: z.string(),
    byteLength: z.number().int().nonnegative(),
  })
  .strict();
export type ServerSentEventRecord = z.infer<typeof serverSentEventRecordSchema>;

export const networkStreamMessageRecordSchema = z.discriminatedUnion("kind", [
  webSocketMessageRecordSchema,
  serverSentEventRecordSchema,
]);
export type NetworkStreamMessageRecord = z.infer<typeof networkStreamMessageRecordSchema>;
