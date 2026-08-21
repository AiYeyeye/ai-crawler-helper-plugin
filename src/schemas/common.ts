import { z } from "zod";

/**
 * Persisted-record schema version. Every record written to IndexedDB or an
 * export file carries this. V1 only guarantees read compatibility within one
 * major version (design 15).
 */
export const SCHEMA_VERSION = 4;
export const schemaVersionSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(SCHEMA_VERSION),
]);

/**
 * Tri-state for absent data (type-safety spec / PRD 4.16).
 *
 * A fact that is not present must be one of:
 *  - `empty`            — truly observed and empty (e.g. zero cookies existed)
 *  - `not_applicable`   — the fact type does not apply to this record kind
 *  - `missing_due_to_gap` — a CaptureGap prevented observation
 *
 * Never `""`, `[]`, `{}` or a default value.
 */
export const absentReasonSchema = z.enum(["empty", "not_applicable", "missing_due_to_gap"]);
export type AbsentReason = z.infer<typeof absentReasonSchema>;

export const absentSchema = z
  .object({
    status: z.literal("absent"),
    reason: absentReasonSchema,
    /** Present when reason is missing_due_to_gap. */
    gapId: z.string().min(1).optional(),
  })
  .strict();
export type Absent = z.infer<typeof absentSchema>;

/** Wrap a value schema into `present | absent` discriminated union. */
export const presentOrAbsent = <T extends z.ZodTypeAny>(value: T) =>
  z.discriminatedUnion("status", [
    z.object({ status: z.literal("present"), value }).strict(),
    absentSchema,
  ]);

/** Capture quality axis, orthogonal to lifecycle (design 4.1). */
export const captureQualitySchema = z.enum(["complete", "degraded"]);
export type CaptureQuality = z.infer<typeof captureQualitySchema>;

/** Ext <-> CDP identifier mapping state (never `===` across spaces). */
export const identifierMappingStateSchema = z.enum(["confirmed", "ambiguous", "unmapped"]);
export type IdentifierMappingState = z.infer<typeof identifierMappingStateSchema>;

/** Epoch milliseconds timestamp. */
export const epochMsSchema = z.number().int().nonnegative();
