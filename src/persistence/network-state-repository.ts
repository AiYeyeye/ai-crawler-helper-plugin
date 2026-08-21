import {
  SESSION_INDEX,
  STORES,
  getAllRecords,
  getRecord,
  runAtomicWrite,
} from "./database";
import {
  buildIdentifierMappingKey,
  debuggerAttachEpochStateSchema,
  identifierMappingKeyPartsSchema,
  identifierMappingRecordSchema,
  inFlightRequestRecordSchema,
  type IdentifierMappingKeyParts,
  type IdentifierMappingRecord,
  type InFlightRequestRecord,
  requestRecordSchema,
  type RequestRecord,
} from "../schemas/network";
import { SCHEMA_VERSION } from "../schemas/common";
import {
  attachEpochSchema,
  type AttachEpoch,
  type ExtTabId,
  type SessionId,
} from "../shared/ids";

const attachEpochStateKey = (sessionId: SessionId, tabId: ExtTabId): string =>
  `debuggerAttachEpoch|${sessionId}|${String(tabId)}`;

export type UpsertIdentifierMappingInput = Omit<
  IdentifierMappingRecord,
  "schemaVersion" | "mappingKey"
>;

/** Durable network coordinator state needed to rebuild after MV3 worker death. */
export class NetworkStateRepository {
  constructor(private readonly db: IDBDatabase) {}

  async listInFlightBySession(sessionId: SessionId): Promise<InFlightRequestRecord[]> {
    const txn = this.db.transaction([STORES.inFlightRequests], "readonly");
    const raws = await getAllRecords(
      txn.objectStore(STORES.inFlightRequests).index(SESSION_INDEX),
      sessionId,
    );
    return raws
      .map((raw) => inFlightRequestRecordSchema.parse(raw))
      .sort((left, right) => left.requestKey.localeCompare(right.requestKey));
  }

  async listInFlightRequestRecordsBySession(sessionId: SessionId): Promise<RequestRecord[]> {
    const txn = this.db.transaction(
      [STORES.inFlightRequests, STORES.requests],
      "readonly",
    );
    const [projectionRaws, requestRaws] = await Promise.all([
      getAllRecords(
        txn.objectStore(STORES.inFlightRequests).index(SESSION_INDEX),
        sessionId,
      ),
      getAllRecords(txn.objectStore(STORES.requests).index(SESSION_INDEX), sessionId),
    ]);
    const inFlightKeys = new Set(
      projectionRaws.map((raw) => inFlightRequestRecordSchema.parse(raw).requestKey),
    );
    return requestRaws
      .map((raw) => requestRecordSchema.parse(raw))
      .filter((record) => inFlightKeys.has(record.requestKey))
      .sort((left, right) => left.requestKey.localeCompare(right.requestKey));
  }

  async upsertIdentifierMapping(
    input: UpsertIdentifierMappingInput,
  ): Promise<IdentifierMappingRecord> {
    const keyParts = identifierMappingKeyPartsSchema.parse({
      sessionId: input.sessionId,
      tabId: input.tabId,
      ...(input.childSessionId === undefined
        ? {}
        : { childSessionId: input.childSessionId }),
      attachEpoch: input.attachEpoch,
      ...(input.frameId === undefined ? {} : { frameId: input.frameId }),
      ...(input.loaderId === undefined ? {} : { loaderId: input.loaderId }),
    });
    const record = identifierMappingRecordSchema.parse({
      ...input,
      schemaVersion: SCHEMA_VERSION,
      mappingKey: buildIdentifierMappingKey(keyParts),
    });
    await runAtomicWrite(this.db, [STORES.identifierMappings], (txn) => {
      txn.objectStore(STORES.identifierMappings).put(record);
      return Promise.resolve();
    });
    return record;
  }

  async getIdentifierMapping(
    keyParts: IdentifierMappingKeyParts,
  ): Promise<IdentifierMappingRecord | null> {
    const parsed = identifierMappingKeyPartsSchema.parse(keyParts);
    const txn = this.db.transaction([STORES.identifierMappings], "readonly");
    const raw = await getRecord(
      txn.objectStore(STORES.identifierMappings),
      buildIdentifierMappingKey(parsed),
    );
    return raw === undefined ? null : identifierMappingRecordSchema.parse(raw);
  }

  async nextAttachEpoch(
    sessionId: SessionId,
    tabId: ExtTabId,
    now: number,
  ): Promise<AttachEpoch> {
    const key = attachEpochStateKey(sessionId, tabId);
    return runAtomicWrite(this.db, [STORES.settings], async (txn) => {
      const store = txn.objectStore(STORES.settings);
      const raw = await getRecord(store, key);
      const previous =
        raw === undefined ? undefined : debuggerAttachEpochStateSchema.parse(raw);
      const next = attachEpochSchema.parse(
        previous === undefined ? 0 : Number(previous.lastAttachEpoch) + 1,
      );
      store.put(
        debuggerAttachEpochStateSchema.parse({
          key,
          sessionId,
          tabId,
          lastAttachEpoch: next,
          updatedAt: now,
        }),
      );
      return next;
    });
  }
}
