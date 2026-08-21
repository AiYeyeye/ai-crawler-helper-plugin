import { SESSION_INDEX, STORES, getAllRecords, getRecord, type StoreName } from "./database";
import { sessionControlRecordSchema, sessionRecordSchema } from "../schemas/session";
import { storedStepSchema } from "../schemas/step";
import { domRecordSchema } from "../schemas/dom";
import { navigationRecordSchema } from "../schemas/navigation";
import {
  networkStreamMessageRecordSchema,
  identifierMappingRecordSchema,
  requestRecordSchema,
  responseBodyRecordSchema,
} from "../schemas/network";
import { storageDiffRecordSchema, storageSnapshotRecordSchema } from "../schemas/storage";
import { captureGapRecordSchema } from "../schemas/capture-gap";
import { businessError } from "../shared/errors";
import type { SessionId } from "../shared/ids";
import type { z } from "zod";

/**
 * Validated export read-back (foundation slice of design 13).
 *
 * Subtask 07 builds the streaming ZIP on top of this contract. The
 * foundation guarantee verified here: every persisted record of a session
 * can be read back and re-validated against its Zod schema — including from
 * `paused_storage_pressure` and `interrupted` sessions (data preserved,
 * never trimmed). Any invalid record fails closed with
 * `EXPORT_VALIDATION_FAILED` instead of exporting silently-broken data.
 */

export interface SessionExportData {
  session: z.infer<typeof sessionRecordSchema>;
  control: z.infer<typeof sessionControlRecordSchema>;
  steps: z.infer<typeof storedStepSchema>[];
  domRecords: z.infer<typeof domRecordSchema>[];
  navigations: z.infer<typeof navigationRecordSchema>[];
  requests: z.infer<typeof requestRecordSchema>[];
  responseBodies: z.infer<typeof responseBodyRecordSchema>[];
  networkStreamMessages: z.infer<typeof networkStreamMessageRecordSchema>[];
  identifierMappings: z.infer<typeof identifierMappingRecordSchema>[];
  storageSnapshots: z.infer<typeof storageSnapshotRecordSchema>[];
  storageDiffs: z.infer<typeof storageDiffRecordSchema>[];
  captureGaps: z.infer<typeof captureGapRecordSchema>[];
}

export class ExportValidationError extends Error {
  readonly businessError;
  constructor(store: string, detail: string) {
    const be = businessError(
      "EXPORT_VALIDATION_FAILED",
      `record in ${store} failed schema validation`,
      { store, detail },
    );
    super(be.message);
    this.name = "ExportValidationError";
    this.businessError = be;
  }
}

const parseRecord = <S extends z.ZodTypeAny>(
  storeName: StoreName,
  raw: unknown,
  schema: S,
): z.infer<S> => {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ExportValidationError(
      storeName,
      parsed.error.issues[0]?.message ?? "unknown",
    );
  }
  return parsed.data as z.infer<S>;
};

const readAllBySession = async <S extends z.ZodTypeAny>(
  db: IDBDatabase,
  storeName: StoreName,
  sessionId: SessionId,
  schema: S,
): Promise<z.infer<S>[]> => {
  const txn = db.transaction([storeName], "readonly");
  const raws = await getAllRecords(
    txn.objectStore(storeName).index(SESSION_INDEX),
    sessionId,
  );
  return raws.map((raw) => parseRecord(storeName, raw, schema));
};

export const collectSessionExportData = async (
  db: IDBDatabase,
  sessionId: SessionId,
): Promise<SessionExportData> => {
  const metaTxn = db.transaction([STORES.sessions, STORES.sessionControl], "readonly");
  const sessionRaw = await getRecord(metaTxn.objectStore(STORES.sessions), sessionId);
  const controlRaw = await getRecord(metaTxn.objectStore(STORES.sessionControl), sessionId);
  if (sessionRaw === undefined || controlRaw === undefined) {
    throw new ExportValidationError(STORES.sessions, `session ${sessionId} not found`);
  }
  const session = parseRecord(STORES.sessions, sessionRaw, sessionRecordSchema);
  const control = parseRecord(STORES.sessionControl, controlRaw, sessionControlRecordSchema);

  return {
    session,
    control,
    steps: await readAllBySession(db, STORES.steps, sessionId, storedStepSchema),
    domRecords: await readAllBySession(db, STORES.domRecords, sessionId, domRecordSchema),
    navigations: await readAllBySession(db, STORES.navigations, sessionId, navigationRecordSchema),
    requests: await readAllBySession(db, STORES.requests, sessionId, requestRecordSchema),
    responseBodies: await readAllBySession(
      db,
      STORES.responseBodies,
      sessionId,
      responseBodyRecordSchema,
    ),
    networkStreamMessages: await readAllBySession(
      db,
      STORES.networkStreamMessages,
      sessionId,
      networkStreamMessageRecordSchema,
    ),
    identifierMappings: await readAllBySession(
      db,
      STORES.identifierMappings,
      sessionId,
      identifierMappingRecordSchema,
    ),
    storageSnapshots: await readAllBySession(
      db,
      STORES.storageSnapshots,
      sessionId,
      storageSnapshotRecordSchema,
    ),
    storageDiffs: await readAllBySession(db, STORES.storageDiffs, sessionId, storageDiffRecordSchema),
    captureGaps: await readAllBySession(db, STORES.captureGaps, sessionId, captureGapRecordSchema),
  };
};
