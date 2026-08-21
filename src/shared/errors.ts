import { z } from "zod";

/**
 * Business error codes crossing context boundaries (design 14).
 *
 * Boundary rule: UI / other contexts only ever see `{ code, message, details? }`.
 * Raw errors and stack traces stay in the local diagnostics of the context
 * that produced them and are NEVER serialized across a boundary.
 */
export const BUSINESS_ERROR_CODES = [
  // --- design.md section 14 ---
  "SITE_PERMISSION_REQUIRED",
  "DEBUGGER_ATTACH_FAILED",
  "PROTECTED_PAGE_UNSUPPORTED",
  "PERSISTENCE_TRANSACTION_FAILED",
  "CAPACITY_ESTIMATE_UNAVAILABLE",
  "RESPONSE_BODY_UNAVAILABLE",
  "EXPORT_VALIDATION_FAILED",
  "RESPONSE_BODY_BUDGET_REACHED",
  "EXPORT_STREAM_FAILED",
  "EXPORT_FILE_PERMISSION_REQUIRED",
  "OFFSCREEN_EXPORT_UNAVAILABLE",
  "OPFS_CLEANUP_FAILED",
  // --- foundation-phase additions (documented; feed back to parent design) ---
  /** Storage-pressure admission rejected the write; session safe-stopped. */
  "CAPACITY_HEADROOM_EXHAUSTED",
  /** Session lifecycle does not accept new facts (paused / stopped / unknown). */
  "SESSION_NOT_ACCEPTING_FACTS",
  /** Structurally valid content observation belongs to an obsolete capture context. */
  "CAPTURE_CONTEXT_STALE",
  /** Requested session does not exist. */
  "SESSION_NOT_FOUND",
  /** Lifecycle transition not allowed from current state. */
  "SESSION_INVALID_TRANSITION",
  /** Collector pipeline (subtasks 02+) not yet registered in this build. */
  "CAPTURE_PIPELINE_UNAVAILABLE",
  /** Message failed protocol schema validation at the receiving boundary. */
  "PROTOCOL_MESSAGE_INVALID",
  // --- subtask 05 storage collector (documented; feed back to parent design) ---
  /** The addressed frame is not part of an active recording session. */
  "CONTENT_SESSION_INACTIVE",
  /** The frame could not read its own page storage. */
  "PAGE_STORAGE_READ_FAILED",
  // --- subtask 06 UI panels (documented; feed back to parent design) ---
  /** Requested step does not exist. */
  "STEP_NOT_FOUND",
] as const;

export const businessErrorCodeSchema = z.enum(BUSINESS_ERROR_CODES);
export type BusinessErrorCode = z.infer<typeof businessErrorCodeSchema>;

/** Serializable business error. No stack, no raw Error fields. */
export const businessErrorSchema = z
  .object({
    code: businessErrorCodeSchema,
    message: z.string(),
    /** Structured, JSON-safe context (ids, counters) — never a stack trace. */
    details: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  })
  .strict();
export type BusinessError = z.infer<typeof businessErrorSchema>;

export const businessError = (
  code: BusinessErrorCode,
  message: string,
  details?: Record<string, string | number | boolean | null>,
): BusinessError => (details === undefined ? { code, message } : { code, message, details });

/** Result type used by every cross-context request/response pair. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: BusinessError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T = never>(error: BusinessError): Result<T> => ({ ok: false, error });

export const resultSchema = <T extends z.ZodTypeAny>(
  value: T,
): z.ZodType<{ ok: true; value: z.infer<T> } | { ok: false; error: BusinessError }> =>
  z.union([
    z.object({ ok: z.literal(true), value }).strict(),
    z.object({ ok: z.literal(false), error: businessErrorSchema }).strict(),
  ]) as z.ZodType<{ ok: true; value: z.infer<T> } | { ok: false; error: BusinessError }>;
