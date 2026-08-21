import type { KeyValueEntry, PageStorageContent } from "../schemas/storage";

/**
 * Page-storage reading inside a content script (design 10).
 *
 * Runs in the frame that owns the storage, so `sessionStorage` isolation
 * between frames is a property of where this executes — never something the
 * Service Worker merges after the fact.
 *
 * Every domain degrades independently: a cross-origin iframe that throws
 * `SecurityError` on `localStorage` must not blank out the cookies or the
 * IndexedDB catalog collected alongside it.
 */

type LocalStorageField = PageStorageContent["localStorage"];
type IndexedDbField = PageStorageContent["indexedDbCatalog"];
type CacheStorageField = PageStorageContent["cacheStorageCatalog"];

/** Structural subset of the `Storage` interface actually used. */
export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
}

/**
 * Read every key/value pair from a Web Storage area.
 *
 * Accessing `localStorage` throws in sandboxed / opaque-origin frames and when
 * the user blocks site data — both become an explicit `not_collected`.
 */
export const readStorageArea = (read: () => StorageLike | null | undefined): LocalStorageField => {
  let area: StorageLike | null | undefined;
  try {
    area = read();
  } catch {
    return { status: "not_collected", reason: "permission_missing" };
  }
  if (area === null || area === undefined) {
    return { status: "not_collected", reason: "not_applicable" };
  }
  try {
    const entries: KeyValueEntry[] = [];
    for (let index = 0; index < area.length; index += 1) {
      const key = area.key(index);
      if (key === null) {
        continue;
      }
      const value = area.getItem(key);
      if (value === null) {
        continue;
      }
      entries.push({ key, value });
    }
    return { status: "collected", value: entries };
  } catch {
    return { status: "not_collected", reason: "missing_due_to_gap" };
  }
};

// ---------------------------------------------------------------------------
// IndexedDB catalog
// ---------------------------------------------------------------------------

export interface IndexedDbInfoLike {
  readonly name?: string;
  readonly version?: number;
}

export interface IndexedDbFactoryLike {
  databases?: () => Promise<readonly IndexedDbInfoLike[]>;
  open(name: string): IDBOpenDBRequestLike;
}

export interface IDBOpenDBRequestLike {
  onsuccess: ((this: unknown, event: unknown) => unknown) | null;
  onerror: ((this: unknown, event: unknown) => unknown) | null;
  onblocked?: ((this: unknown, event: unknown) => unknown) | null;
  onupgradeneeded?: ((this: unknown, event: unknown) => unknown) | null;
  result?: IDBDatabaseLike;
}

export interface IDBDatabaseLike {
  readonly name: string;
  readonly version: number;
  readonly objectStoreNames: { readonly length: number; item(index: number): string | null };
  transaction(names: readonly string[], mode: "readonly"): IDBTransactionLike;
  close(): void;
}

export interface IDBTransactionLike {
  objectStore(name: string): IDBObjectStoreLike;
  abort?: () => void;
}

export interface IDBObjectStoreLike {
  readonly keyPath: unknown;
  readonly autoIncrement: boolean;
  readonly indexNames: { readonly length: number; item(index: number): string | null };
}

const toNameList = (list: {
  readonly length: number;
  item(index: number): string | null;
}): string[] => {
  const names: string[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const name = list.item(index);
    if (name !== null) {
      names.push(name);
    }
  }
  return names;
};

/** Only string keyPaths are representable in the schema; composite ones are joined. */
const normalizeKeyPath = (keyPath: unknown): string | undefined => {
  if (typeof keyPath === "string") {
    return keyPath;
  }
  if (Array.isArray(keyPath)) {
    return keyPath.filter((part): part is string => typeof part === "string").join(",");
  }
  return undefined;
};

const openDatabase = (factory: IndexedDbFactoryLike, name: string): Promise<IDBDatabaseLike | null> =>
  new Promise((resolve) => {
    let request: IDBOpenDBRequestLike;
    try {
      request = factory.open(name);
    } catch {
      resolve(null);
      return;
    }
    request.onsuccess = (): void => {
      resolve(request.result ?? null);
    };
    request.onerror = (): void => {
      resolve(null);
    };
    // A blocked open would hang the snapshot; treat it as unreadable instead.
    if ("onblocked" in request) {
      request.onblocked = (): void => {
        resolve(null);
      };
    }
  });

/**
 * Catalog-level IndexedDB information only — database names, versions, object
 * store schemas. Record contents are never exported by default (design 10).
 */
export const readIndexedDbCatalog = async (
  factory: IndexedDbFactoryLike | undefined,
): Promise<IndexedDbField> => {
  if (factory === undefined || typeof factory.databases !== "function") {
    // Chrome supports databases(); anything else cannot be enumerated at all.
    return { status: "not_collected", reason: "not_applicable" };
  }
  let infos: readonly IndexedDbInfoLike[];
  try {
    infos = await factory.databases();
  } catch {
    return { status: "not_collected", reason: "missing_due_to_gap" };
  }

  const catalog: {
    databaseName: string;
    version?: number;
    objectStores: { name: string; keyPath?: string; autoIncrement?: boolean; indexNames: string[] }[];
  }[] = [];

  for (const info of infos) {
    if (info.name === undefined) {
      continue;
    }
    const database = await openDatabase(factory, info.name);
    if (database === null) {
      catalog.push({
        databaseName: info.name,
        ...(info.version === undefined ? {} : { version: info.version }),
        objectStores: [],
      });
      continue;
    }
    try {
      const storeNames = toNameList(database.objectStoreNames);
      const objectStores = storeNames.length === 0 ? [] : readObjectStores(database, storeNames);
      catalog.push({
        databaseName: database.name,
        version: database.version,
        objectStores,
      });
    } catch {
      catalog.push({
        databaseName: info.name,
        ...(info.version === undefined ? {} : { version: info.version }),
        objectStores: [],
      });
    } finally {
      try {
        database.close();
      } catch {
        // Closing is best-effort; the snapshot is already captured.
      }
    }
  }
  return { status: "collected", value: catalog };
};

const readObjectStores = (
  database: IDBDatabaseLike,
  storeNames: readonly string[],
): { name: string; keyPath?: string; autoIncrement?: boolean; indexNames: string[] }[] => {
  const transaction = database.transaction(storeNames, "readonly");
  return storeNames.map((name) => {
    const store = transaction.objectStore(name);
    const keyPath = normalizeKeyPath(store.keyPath);
    return {
      name,
      ...(keyPath === undefined ? {} : { keyPath }),
      autoIncrement: store.autoIncrement,
      indexNames: toNameList(store.indexNames),
    };
  });
};

// ---------------------------------------------------------------------------
// CacheStorage catalog
// ---------------------------------------------------------------------------

export interface CacheLike {
  keys(): Promise<readonly { readonly url: string }[]>;
}

export interface CacheStorageLike {
  keys(): Promise<readonly string[]>;
  open(cacheName: string): Promise<CacheLike>;
}

/**
 * Catalog-level CacheStorage information: cache names and the request URLs they
 * hold. Response bodies are deliberately not read — `statusCode`/`responseType`
 * stay absent rather than forcing a `match()` per entry.
 */
export const readCacheStorageCatalog = async (
  caches: CacheStorageLike | undefined,
): Promise<CacheStorageField> => {
  if (caches === undefined) {
    return { status: "not_collected", reason: "not_applicable" };
  }
  let cacheNames: readonly string[];
  try {
    cacheNames = await caches.keys();
  } catch {
    // Non-secure contexts reject CacheStorage access outright.
    return { status: "not_collected", reason: "permission_missing" };
  }
  const catalog: { cacheName: string; entries: { requestUrl: string }[] }[] = [];
  for (const cacheName of cacheNames) {
    try {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();
      catalog.push({
        cacheName,
        entries: requests.map((request) => ({ requestUrl: request.url })),
      });
    } catch {
      catalog.push({ cacheName, entries: [] });
    }
  }
  return { status: "collected", value: catalog };
};

// ---------------------------------------------------------------------------
// Frame-level aggregate
// ---------------------------------------------------------------------------

export interface PageStorageSources {
  readonly localStorage: () => StorageLike | null | undefined;
  readonly sessionStorage: () => StorageLike | null | undefined;
  readonly indexedDb: IndexedDbFactoryLike | undefined;
  readonly caches: CacheStorageLike | undefined;
}

export type PageStorageReadResult = PageStorageContent;

/** Read every page-owned storage domain for the current frame. */
export const readPageStorage = async (
  sources: PageStorageSources,
): Promise<PageStorageReadResult> => ({
  localStorage: readStorageArea(sources.localStorage),
  sessionStorage: readStorageArea(sources.sessionStorage),
  indexedDbCatalog: await readIndexedDbCatalog(sources.indexedDb),
  cacheStorageCatalog: await readCacheStorageCatalog(sources.caches),
});

/** Bind to the real frame globals. */
export const browserPageStorageSources = (view: Window): PageStorageSources => ({
  localStorage: () => view.localStorage,
  sessionStorage: () => view.sessionStorage,
  indexedDb: view.indexedDB as unknown as IndexedDbFactoryLike | undefined,
  caches: (view as unknown as { caches?: CacheStorageLike }).caches,
});
