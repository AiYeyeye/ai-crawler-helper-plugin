import { SESSION_INDEX, STORES, getAllRecords } from "../persistence/database";
import type { SessionId } from "../shared/ids";
import {
  documentContextRecordSchema,
  sessionTabRecordSchema,
  type DocumentContextRecord,
  type SessionTabRecord,
} from "../schemas/navigation";
import { z } from "zod";

export const contextIndexRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.string(),
    tabs: z.array(sessionTabRecordSchema),
    documents: z.array(documentContextRecordSchema),
    generatedAt: z.number().int(),
  })
  .strict();

export type ContextIndexRecord = z.infer<typeof contextIndexRecordSchema>;

export const buildContextIndex = async (
  db: IDBDatabase,
  sessionId: SessionId,
): Promise<ContextIndexRecord> => {
  const tabTxn = db.transaction([STORES.tabs], "readonly");
  const tabRaws = await getAllRecords(
    tabTxn.objectStore(STORES.tabs).index(SESSION_INDEX),
    sessionId,
  );
  const tabs: SessionTabRecord[] = tabRaws.map((r) => sessionTabRecordSchema.parse(r));

  const docTxn = db.transaction([STORES.documents], "readonly");
  const docRaws = await getAllRecords(
    docTxn.objectStore(STORES.documents).index(SESSION_INDEX),
    sessionId,
  );
  const documents: DocumentContextRecord[] = docRaws.map((r) =>
    documentContextRecordSchema.parse(r),
  );

  return contextIndexRecordSchema.parse({
    schemaVersion: 1,
    sessionId,
    tabs,
    documents,
    generatedAt: Date.now(),
  });
};
