import { z } from "zod";
import { captureEpochIdSchema, exportJobIdSchema, sessionIdSchema, stepIdSchema } from "./ids";
import { businessErrorSchema } from "./errors";
import { envelopeAckSchema, eventEnvelopeSchema } from "../schemas/event-envelope";
import { sessionRecordSchema, sessionControlRecordSchema } from "../schemas/session";
import { storedStepSchema } from "../schemas/step";
import { captureGapRecordSchema } from "../schemas/capture-gap";
import { pageStorageContentSchema, storageDiffRecordSchema } from "../schemas/storage";
import { requestRecordSchema } from "../schemas/network";
import { appSettingsSchema, sessionConfigPatchSchema } from "../schemas/settings";
import { localeSchema } from "./i18n";
import { contentObservationEnvelopeSchema } from "../schemas/content-observation";
import { sessionConfigSchema } from "../schemas/session";
import { stepScopeSchema } from "../schemas/step";
import { exportJobStateSchema } from "../schemas/export";

/**
 * Cross-context message protocol (design 2: UI talks to the service worker
 * ONLY through this contract; it never touches repositories directly).
 *
 * Every message carries `protocolVersion`; receivers validate with Zod at the
 * boundary and reply `PROTOCOL_MESSAGE_INVALID` on failure — they never throw
 * raw errors across the boundary.
 */

export const PROTOCOL_VERSION = 1;
const protocolVersionSchema = z.literal(PROTOCOL_VERSION);

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const runtimeRequestSchema = z.discriminatedUnion("type", [
  /** Content script -> SW: batch of fact envelopes; replied with per-event ACKs. */
  z
    .object({
      protocolVersion: protocolVersionSchema,
      type: z.literal("facts/submit"),
      envelopes: z.array(eventEnvelopeSchema).min(1),
    })
    .strict(),
  /** Content script -> SW: raw observations; SW owns Step ids/ordinals. */
  z
    .object({
      protocolVersion: protocolVersionSchema,
      type: z.literal("observations/submit"),
      observations: z.array(contentObservationEnvelopeSchema).min(1),
    })
    .strict(),
  /** UI -> SW commands. */
  z
    .object({
      protocolVersion: protocolVersionSchema,
      type: z.literal("command/startRecording"),
      mode: z.enum(["no_reload", "reload"]),
      tabId: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      protocolVersion: protocolVersionSchema,
      type: z.literal("command/stopRecording"),
      sessionId: sessionIdSchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: protocolVersionSchema,
      type: z.literal("command/resumeAfterStoragePressure"),
      sessionId: sessionIdSchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: protocolVersionSchema,
      type: z.literal("command/deleteSession"),
      sessionId: sessionIdSchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: protocolVersionSchema,
      type: z.literal("command/exportSession"),
      sessionId: sessionIdSchema,
      format: z.enum(["zip", "single_json"]).optional(),
      sink: z.enum(["file_system_writable", "opfs_downloads_fallback"]).optional(),
    })
    .strict(),
  /** Offscreen document -> SW: downloads is unavailable in offscreen contexts. */
  z
    .object({
      protocolVersion: protocolVersionSchema,
      type: z.literal("offscreen/download/start"),
      url: z.string().min(1),
      filename: z.string().min(1),
      saveAs: z.boolean(),
    })
    .strict(),
  /** UI -> SW queries (read-only repository snapshots). */
  z
    .object({
      protocolVersion: protocolVersionSchema,
      type: z.literal("query/listSessions"),
    })
    .strict(),
  z
    .object({
      protocolVersion: protocolVersionSchema,
      type: z.literal("query/sessionSnapshot"),
      sessionId: sessionIdSchema,
    })
    .strict(),
  /** Content script -> SW: handshake to recover session context (design 8). */
  z
    .object({
      protocolVersion: protocolVersionSchema,
      type: z.literal("handshake/contentScript"),
      url: z.string(),
    })
    .strict(),
  /**
   * Review-layer edit (PRD 4.15). Raw facts are immutable; this only flips
   * `excluded` or sets/clears `note`.
   */
  z
    .object({
      protocolVersion: protocolVersionSchema,
      type: z.literal("command/updateStepReview"),
      stepId: stepIdSchema,
      excluded: z.boolean().optional(),
      /** `null` clears the note; omitted leaves it unchanged. */
      note: z.string().nullable().optional(),
    })
    .strict(),
  /** Step detail for the Side Panel timeline expansion. */
  z
    .object({
      protocolVersion: protocolVersionSchema,
      type: z.literal("query/stepDetail"),
      stepId: stepIdSchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: protocolVersionSchema,
      type: z.literal("query/appSettings"),
    })
    .strict(),
  z
    .object({
      protocolVersion: protocolVersionSchema,
      type: z.literal("command/updateAppSettings"),
      patch: sessionConfigPatchSchema,
    })
    .strict(),
  /**
   * UI/export language (crawler-12). Stored in app settings; takes effect
   * globally and immediately. Export reads it once at start (snapshot).
   */
  z
    .object({
      protocolVersion: protocolVersionSchema,
      type: z.literal("command/updateLocale"),
      locale: localeSchema,
    })
    .strict(),
]);
export type RuntimeRequest = z.infer<typeof runtimeRequestSchema>;

// ---------------------------------------------------------------------------
// Response payloads
// ---------------------------------------------------------------------------

export const factsSubmitResponseSchema = z
  .object({ acks: z.array(envelopeAckSchema) })
  .strict();
export type FactsSubmitResponse = z.infer<typeof factsSubmitResponseSchema>;

export const observationsSubmitResponseSchema = factsSubmitResponseSchema;
export type ObservationsSubmitResponse = FactsSubmitResponse;

export const sessionSnapshotSchema = z
  .object({
    session: sessionRecordSchema,
    control: sessionControlRecordSchema,
    steps: z.array(storedStepSchema),
    gaps: z.array(captureGapRecordSchema),
  })
  .strict();
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;

export const listSessionsResponseSchema = z
  .object({ sessions: z.array(sessionRecordSchema) })
  .strict();
export type ListSessionsResponse = z.infer<typeof listSessionsResponseSchema>;

export const exportSessionResponseSchema = z
  .object({
    jobId: exportJobIdSchema,
    state: exportJobStateSchema,
  })
  .strict();
export type ExportSessionResponse = z.infer<typeof exportSessionResponseSchema>;

export const downloadStartResponseSchema = z
  .object({ downloadId: z.number().int().nonnegative() })
  .strict();
export type DownloadStartResponse = z.infer<typeof downloadStartResponseSchema>;

/**
 * Everything the Side Panel needs to expand one Step. Raw records only — the
 * fact summary is derived in the UI by the deterministic FactSummaryBuilder,
 * so the summary never becomes a second source of truth on the wire.
 */
export const stepDetailSchema = z
  .object({
    step: storedStepSchema,
    requests: z.array(requestRecordSchema),
    storageDiffs: z.array(storageDiffRecordSchema),
  })
  .strict();
export type StepDetail = z.infer<typeof stepDetailSchema>;

export const appSettingsResponseSchema = appSettingsSchema;

export const startRecordingResponseSchema = z
  .object({ sessionId: sessionIdSchema })
  .strict();

export const handshakeResponseSchema = z.discriminatedUnion("active", [
  z.object({ active: z.literal(false) }).strict(),
  z
    .object({
      active: z.literal(true),
      sessionId: sessionIdSchema,
      captureEpochId: captureEpochIdSchema,
      scope: stepScopeSchema,
      config: sessionConfigSchema,
      historyBridgeToken: z.string().min(1).optional(),
    })
    .strict(),
]);
export type HandshakeResponse = z.infer<typeof handshakeResponseSchema>;

// ---------------------------------------------------------------------------
// Service worker -> content script commands
// ---------------------------------------------------------------------------

/**
 * The Service Worker cannot read page storage; only the frame that owns it can.
 * These commands are delivered per (tabId, frameId) so `sessionStorage` stays
 * frame-isolated — the worker never merges areas across frames.
 */
export const contentCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      protocolVersion: protocolVersionSchema,
      type: z.literal("content/collectPageStorage"),
      sessionId: sessionIdSchema,
    })
    .strict(),
]);
export type ContentCommand = z.infer<typeof contentCommandSchema>;

export const collectPageStorageResponseSchema = z
  .object({
    /** The frame's own origin, used to tag key/value diff entries. */
    origin: z.string(),
    content: pageStorageContentSchema,
  })
  .strict();
export type CollectPageStorageResponse = z.infer<typeof collectPageStorageResponseSchema>;

// ---------------------------------------------------------------------------
// Generic response envelope
// ---------------------------------------------------------------------------

export const runtimeResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: businessErrorSchema }).strict(),
]);
export type RuntimeResponse = z.infer<typeof runtimeResponseSchema>;
