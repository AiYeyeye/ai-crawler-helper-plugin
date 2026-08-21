import { z } from "zod";
import {
  extFrameIdSchema,
  extTabIdSchema,
  gapIdSchema,
  sessionIdSchema,
  stepIdSchema,
  storageRecordIdSchema,
} from "../shared/ids";
import { epochMsSchema, schemaVersionSchema } from "./common";

/**
 * Cookie / browser storage facts (PRD 4.8, design 10).
 */

export const cookieRecordSchema = z
  .object({
    name: z.string(),
    /** Raw value, never masked (PRD 4.9). */
    value: z.string(),
    domain: z.string(),
    path: z.string(),
    expiresAt: z.number().optional(),
    httpOnly: z.boolean(),
    secure: z.boolean(),
    sameSite: z.enum(["no_restriction", "lax", "strict", "unspecified"]),
    partitioned: z.boolean().optional(),
  })
  .strict();
export type CookieRecord = z.infer<typeof cookieRecordSchema>;

export const keyValueEntrySchema = z
  .object({ key: z.string(), value: z.string() })
  .strict();
export type KeyValueEntry = z.infer<typeof keyValueEntrySchema>;

/** Page-storage areas that carry full key/value pairs. */
export const storageAreaSchema = z.enum(["localStorage", "sessionStorage"]);
export type StorageArea = z.infer<typeof storageAreaSchema>;

/** IndexedDB catalog info only — no full record export by default. */
export const indexedDbCatalogSchema = z.array(
  z
    .object({
      databaseName: z.string(),
      version: z.number().int().optional(),
      objectStores: z.array(
        z
          .object({
            name: z.string(),
            keyPath: z.string().optional(),
            autoIncrement: z.boolean().optional(),
            indexNames: z.array(z.string()),
          })
          .strict(),
      ),
    })
    .strict(),
);

/** CacheStorage catalog info only. */
export const cacheStorageCatalogSchema = z.array(
  z
    .object({
      cacheName: z.string(),
      entries: z.array(
        z
          .object({
            requestUrl: z.string(),
            statusCode: z.number().int().optional(),
            responseType: z.string().optional(),
          })
          .strict(),
      ),
    })
    .strict(),
);

/**
 * A collected-or-not wrapper: a storage domain that could not be read must be
 * explicit, never an empty object pretending success.
 */
const collectedSchema = <T extends z.ZodTypeAny>(value: T) =>
  z.discriminatedUnion("status", [
    z.object({ status: z.literal("collected"), value }).strict(),
    z
      .object({
        status: z.literal("not_collected"),
        reason: z.enum(["permission_missing", "not_applicable", "missing_due_to_gap"]),
        gapId: gapIdSchema.optional(),
      })
      .strict(),
  ]);

/**
 * Storage domains owned by the page and readable only inside its own frame.
 * `sessionStorage` isolation between frames is a property of where this is
 * read, so this shape travels from the content script to the Service Worker.
 */
export const pageStorageContentSchema = z
  .object({
    localStorage: collectedSchema(z.array(keyValueEntrySchema)),
    sessionStorage: collectedSchema(z.array(keyValueEntrySchema)),
    indexedDbCatalog: collectedSchema(indexedDbCatalogSchema),
    cacheStorageCatalog: collectedSchema(cacheStorageCatalogSchema),
  })
  .strict();
export type PageStorageContent = z.infer<typeof pageStorageContentSchema>;

/** Page storage plus cookies, which only the Service Worker can read. */
export const storageSnapshotContentSchema = pageStorageContentSchema
  .extend({ cookies: collectedSchema(z.array(cookieRecordSchema)) })
  .strict();
export type StorageSnapshotContent = z.infer<typeof storageSnapshotContentSchema>;

export const storageSnapshotRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    storageRecordId: storageRecordIdSchema,
    sessionId: sessionIdSchema,
    role: z.enum(["initial", "final"]),
    origin: z.string(),
    tabId: extTabIdSchema.optional(),
    frameId: extFrameIdSchema.optional(),
    content: storageSnapshotContentSchema,
    /** Stable canonical-serialization hash for chain verification. */
    snapshotHash: z.string(),
    recordedAt: epochMsSchema,
  })
  .strict();
export type StorageSnapshotRecord = z.infer<typeof storageSnapshotRecordSchema>;

// ---------------------------------------------------------------------------
// Per-step diff
// ---------------------------------------------------------------------------

export const diffEntrySchema = z.discriminatedUnion("entryKind", [
  z.object({ entryKind: z.literal("cookie"), cookie: cookieRecordSchema }).strict(),
  z
    .object({
      entryKind: z.literal("kv"),
      area: storageAreaSchema,
      origin: z.string(),
      entry: keyValueEntrySchema,
    })
    .strict(),
]);
export type StorageDiffEntry = z.infer<typeof diffEntrySchema>;

export const updatedEntrySchema = z.discriminatedUnion("entryKind", [
  z
    .object({
      entryKind: z.literal("cookie"),
      before: cookieRecordSchema,
      after: cookieRecordSchema,
    })
    .strict(),
  z
    .object({
      entryKind: z.literal("kv"),
      area: storageAreaSchema,
      origin: z.string(),
      key: z.string(),
      valueBefore: z.string(),
      valueAfter: z.string(),
    })
    .strict(),
]);
export type StorageUpdatedEntry = z.infer<typeof updatedEntrySchema>;

export const storageDiffRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    storageRecordId: storageRecordIdSchema,
    sessionId: sessionIdSchema,
    /** Step during which the diff was observed (observation-time attribution). */
    observedDuringStepId: stepIdSchema,
    inFlightRequestKeys: z.array(z.string()),
    added: z.array(diffEntrySchema),
    updated: z.array(updatedEntrySchema),
    removed: z.array(diffEntrySchema),
    snapshotHash: z.string(),
    recordedAt: epochMsSchema,
  })
  .strict();
export type StorageDiffRecord = z.infer<typeof storageDiffRecordSchema>;
