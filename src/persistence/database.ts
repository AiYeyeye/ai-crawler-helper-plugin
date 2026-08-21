/**
 * IndexedDB database (design 12).
 *
 * Object stores hold Zod-validated records only; every read-back is parsed
 * before use. The factory is injectable so integration tests run on
 * fake-indexeddb with per-test isolation.
 */

export const DB_NAME = "ai-crawler-helper";
export const DB_VERSION = 4;

export const STORES = {
  sessions: "sessions",
  sessionControl: "sessionControl",
  inbox: "inbox",
  steps: "steps",
  domRecords: "domRecords",
  navigations: "navigations",
  requests: "requests",
  inFlightRequests: "inFlightRequests",
  responseBodies: "responseBodies",
  networkStreamMessages: "networkStreamMessages",
  identifierMappings: "identifierMappings",
  storageSnapshots: "storageSnapshots",
  storageDiffs: "storageDiffs",
  captureGaps: "captureGaps",
  tabs: "tabs",
  documents: "documents",
  exportSnapshots: "exportSnapshots",
  exportJobs: "exportJobs",
  settings: "settings",
} as const;
export type StoreName = (typeof STORES)[keyof typeof STORES];

const BY_SESSION = "bySession";

interface StoreSpec {
  keyPath: string;
  sessionIndexKeyPath?: string;
}

const STORE_SPECS: Readonly<Record<StoreName, StoreSpec>> = {
  sessions: { keyPath: "sessionId" },
  sessionControl: { keyPath: "sessionId" },
  inbox: { keyPath: "eventId", sessionIndexKeyPath: "sessionId" },
  steps: { keyPath: "stepId", sessionIndexKeyPath: "sessionId" },
  domRecords: { keyPath: "domRecordId", sessionIndexKeyPath: "sessionId" },
  navigations: { keyPath: "navigationRecordId", sessionIndexKeyPath: "sessionId" },
  requests: { keyPath: "requestKey", sessionIndexKeyPath: "sessionId" },
  inFlightRequests: { keyPath: "requestKey", sessionIndexKeyPath: "sessionId" },
  responseBodies: { keyPath: "bodyRef", sessionIndexKeyPath: "sessionId" },
  networkStreamMessages: { keyPath: "messageId", sessionIndexKeyPath: "sessionId" },
  identifierMappings: { keyPath: "mappingKey", sessionIndexKeyPath: "sessionId" },
  storageSnapshots: { keyPath: "storageRecordId", sessionIndexKeyPath: "sessionId" },
  storageDiffs: { keyPath: "storageRecordId", sessionIndexKeyPath: "sessionId" },
  captureGaps: { keyPath: "gapId", sessionIndexKeyPath: "scope.sessionId" },
  tabs: { keyPath: "tabKey", sessionIndexKeyPath: "sessionId" },
  documents: { keyPath: "documentKey", sessionIndexKeyPath: "sessionId" },
  exportSnapshots: { keyPath: "snapshotId", sessionIndexKeyPath: "sessionId" },
  exportJobs: { keyPath: "jobId", sessionIndexKeyPath: "sessionId" },
  settings: { keyPath: "key" },
};

/**
 * Idempotent upgrade: creating stores/indexes only when absent, so a crashed
 * upgrade can be re-run without duplicating or destroying data (state-mgmt
 * spec: migrations are idempotent; old sessions never destroyed in place).
 */
const applySchema = (db: IDBDatabase, txn: IDBTransaction): void => {
  for (const [name, spec] of Object.entries(STORE_SPECS) as [StoreName, StoreSpec][]) {
    const store = db.objectStoreNames.contains(name)
      ? txn.objectStore(name)
      : db.createObjectStore(name, { keyPath: spec.keyPath });
    if (spec.sessionIndexKeyPath !== undefined && !store.indexNames.contains(BY_SESSION)) {
      store.createIndex(BY_SESSION, spec.sessionIndexKeyPath, { unique: false });
    }
  }
};

export const openDatabase = (
  factory: IDBFactory = indexedDB,
  name: string = DB_NAME,
): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = factory.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const txn = request.transaction;
      if (txn === null) {
        return;
      }
      applySchema(request.result, txn);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(asError(request.error, "openDatabase failed"));
    };
    request.onblocked = () => {
      reject(new Error("openDatabase blocked by another connection"));
    };
  });

export const SESSION_INDEX = BY_SESSION;

const asError = (raw: unknown, fallback: string): Error =>
  raw instanceof Error ? raw : new Error(fallback);

// ---------------------------------------------------------------------------
// Promise helpers with strict transaction discipline
// ---------------------------------------------------------------------------

export const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(asError(request.error, "IDBRequest failed"));
    };
  });

/**
 * Typed read helpers: lib.dom types `get`/`getAll` as `IDBRequest<any>`;
 * these wrappers pin the result to `unknown` so every read-back MUST be
 * validated with a Zod schema before use (type-safety spec).
 */
export const getRecord = (
  store: IDBObjectStore | IDBIndex,
  key: IDBValidKey,
): Promise<unknown> => requestToPromise<unknown>(store.get(key) as IDBRequest<unknown>);

export const getAllRecords = (
  store: IDBObjectStore | IDBIndex,
  key?: IDBValidKey,
): Promise<unknown[]> =>
  requestToPromise<unknown[]>(store.getAll(key) as IDBRequest<unknown[]>);

export const transactionDone = (txn: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    txn.oncomplete = () => {
      resolve();
    };
    txn.onabort = () => {
      reject(asError(txn.error, "transaction aborted"));
    };
    txn.onerror = () => {
      // onabort will also fire; keep the first concrete error.
      reject(asError(txn.error, "transaction error"));
    };
  });

/**
 * Run one SHORT atomic readwrite transaction. The work callback must issue
 * IndexedDB requests only (no external awaits — auto-commit would close the
 * transaction and break atomicity, see state-management spec).
 *
 * Either every write in `work` commits, or none do.
 */
export const runAtomicWrite = async <T>(
  db: IDBDatabase,
  storeNames: readonly StoreName[],
  work: (txn: IDBTransaction) => Promise<T>,
): Promise<T> => {
  const txn = db.transaction([...storeNames], "readwrite");
  const done = transactionDone(txn);
  try {
    const result = await work(txn);
    await done;
    return result;
  } catch (cause) {
    try {
      txn.abort();
    } catch {
      // already aborted/committed — nothing further to do
    }
    // Surface the original cause, not the secondary abort error.
    await done.catch(() => undefined);
    throw cause;
  }
};

/** Detect quota-class failures for CapacityGuard escalation. */
export const isQuotaExceededError = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === "QuotaExceededError"
    : error instanceof Error && error.name === "QuotaExceededError";
