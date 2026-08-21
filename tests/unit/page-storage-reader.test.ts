import { describe, expect, it } from "vitest";
import {
  readCacheStorageCatalog,
  readIndexedDbCatalog,
  readPageStorage,
  readStorageArea,
  type CacheStorageLike,
  type IDBDatabaseLike,
  type IDBOpenDBRequestLike,
  type IndexedDbFactoryLike,
  type StorageLike,
} from "../../src/content/page-storage-reader";

const fakeStorage = (entries: Record<string, string>): StorageLike => {
  const keys = Object.keys(entries);
  return {
    length: keys.length,
    key: (index) => keys[index] ?? null,
    getItem: (key) => entries[key] ?? null,
  };
};

const nameList = (names: readonly string[]): { length: number; item(i: number): string | null } => ({
  length: names.length,
  item: (index) => names[index] ?? null,
});

interface FakeStoreSpec {
  readonly name: string;
  readonly keyPath?: unknown;
  readonly autoIncrement?: boolean;
  readonly indexNames?: readonly string[];
}

const fakeDatabase = (
  name: string,
  version: number,
  stores: readonly FakeStoreSpec[],
): IDBDatabaseLike => ({
  name,
  version,
  objectStoreNames: nameList(stores.map((store) => store.name)),
  transaction: () => ({
    objectStore: (storeName: string) => {
      const spec = stores.find((store) => store.name === storeName);
      return {
        keyPath: spec?.keyPath ?? null,
        autoIncrement: spec?.autoIncrement ?? false,
        indexNames: nameList(spec?.indexNames ?? []),
      };
    },
  }),
  close: () => undefined,
});

const fakeIdbFactory = (
  databases: readonly { name: string; version: number; stores: readonly FakeStoreSpec[] }[],
): IndexedDbFactoryLike => ({
  databases: () =>
    Promise.resolve(databases.map(({ name, version }) => ({ name, version }))),
  open: (name: string): IDBOpenDBRequestLike => {
    const spec = databases.find((database) => database.name === name);
    const request: IDBOpenDBRequestLike = {
      onsuccess: null,
      onerror: null,
      ...(spec === undefined
        ? {}
        : { result: fakeDatabase(spec.name, spec.version, spec.stores) }),
    };
    queueMicrotask(() => {
      if (spec === undefined) {
        request.onerror?.call(request, {});
      } else {
        request.onsuccess?.call(request, {});
      }
    });
    return request;
  },
});

describe("web storage area reading", () => {
  it("reads every key/value pair", () => {
    const result = readStorageArea(() => fakeStorage({ a: "1", b: "2" }));
    expect(result.status).toBe("collected");
    if (result.status === "collected") {
      expect(result.value).toEqual([
        { key: "a", value: "1" },
        { key: "b", value: "2" },
      ]);
    }
  });

  it("an empty but readable area is collected-and-empty", () => {
    expect(readStorageArea(() => fakeStorage({}))).toEqual({ status: "collected", value: [] });
  });

  it("a SecurityError (sandboxed frame / blocked site data) becomes permission_missing", () => {
    const result = readStorageArea(() => {
      throw new Error("SecurityError");
    });
    expect(result).toEqual({ status: "not_collected", reason: "permission_missing" });
  });

  it("an absent storage object becomes not_applicable, not an empty list", () => {
    expect(readStorageArea(() => undefined)).toEqual({
      status: "not_collected",
      reason: "not_applicable",
    });
  });

  it("a mid-iteration failure degrades to a gap rather than a truncated list", () => {
    const flaky: StorageLike = {
      length: 2,
      key: (index) => (index === 0 ? "a" : "b"),
      getItem: (key) => {
        if (key === "b") {
          throw new Error("boom");
        }
        return "1";
      },
    };
    expect(readStorageArea(() => flaky)).toEqual({
      status: "not_collected",
      reason: "missing_due_to_gap",
    });
  });
});

describe("IndexedDB catalog", () => {
  it("collects database names, versions and object store schemas", async () => {
    const result = await readIndexedDbCatalog(
      fakeIdbFactory([
        {
          name: "app",
          version: 3,
          stores: [
            { name: "users", keyPath: "id", autoIncrement: true, indexNames: ["byEmail"] },
          ],
        },
      ]),
    );
    expect(result.status).toBe("collected");
    if (result.status === "collected") {
      expect(result.value).toEqual([
        {
          databaseName: "app",
          version: 3,
          objectStores: [
            { name: "users", keyPath: "id", autoIncrement: true, indexNames: ["byEmail"] },
          ],
        },
      ]);
    }
  });

  it("joins composite keyPaths into a representable string", async () => {
    const result = await readIndexedDbCatalog(
      fakeIdbFactory([
        { name: "app", version: 1, stores: [{ name: "s", keyPath: ["a", "b"] }] },
      ]),
    );
    if (result.status === "collected") {
      expect(result.value[0]?.objectStores[0]).toMatchObject({ keyPath: "a,b" });
    }
  });

  it("a runtime without databases() is not_applicable, not an empty catalog", async () => {
    const result = await readIndexedDbCatalog({ open: () => ({ onsuccess: null, onerror: null }) });
    expect(result).toEqual({ status: "not_collected", reason: "not_applicable" });
  });

  it("a failing databases() call becomes a gap", async () => {
    const result = await readIndexedDbCatalog({
      databases: () => Promise.reject(new Error("boom")),
      open: () => ({ onsuccess: null, onerror: null }),
    });
    expect(result).toEqual({ status: "not_collected", reason: "missing_due_to_gap" });
  });

  it("a database that cannot be opened still appears, with no stores claimed", async () => {
    const factory: IndexedDbFactoryLike = {
      databases: () => Promise.resolve([{ name: "locked", version: 2 }]),
      open: () => {
        const request: IDBOpenDBRequestLike = { onsuccess: null, onerror: null };
        queueMicrotask(() => request.onerror?.call(request, {}));
        return request;
      },
    };
    const result = await readIndexedDbCatalog(factory);
    if (result.status === "collected") {
      expect(result.value).toEqual([
        { databaseName: "locked", version: 2, objectStores: [] },
      ]);
    }
  });

  it("never reads record contents — only catalog metadata", async () => {
    const result = await readIndexedDbCatalog(
      fakeIdbFactory([{ name: "app", version: 1, stores: [{ name: "users" }] }]),
    );
    expect(result.status).toBe("collected");
    if (result.status === "collected") {
      const database = result.value[0];
      expect(Object.keys(database ?? {}).sort()).toEqual([
        "databaseName",
        "objectStores",
        "version",
      ]);
      expect(Object.keys(database?.objectStores[0] ?? {}).sort()).toEqual([
        "autoIncrement",
        "indexNames",
        "name",
      ]);
    }
  });
});

describe("CacheStorage catalog", () => {
  it("collects cache names and request URLs", async () => {
    const caches: CacheStorageLike = {
      keys: () => Promise.resolve(["v1"]),
      open: () =>
        Promise.resolve({ keys: () => Promise.resolve([{ url: "https://example.com/app.js" }]) }),
    };
    const result = await readCacheStorageCatalog(caches);
    expect(result).toEqual({
      status: "collected",
      value: [{ cacheName: "v1", entries: [{ requestUrl: "https://example.com/app.js" }] }],
    });
  });

  it("an absent CacheStorage is not_applicable", async () => {
    expect(await readCacheStorageCatalog(undefined)).toEqual({
      status: "not_collected",
      reason: "not_applicable",
    });
  });

  it("a rejected keys() (insecure context) becomes permission_missing", async () => {
    const result = await readCacheStorageCatalog({
      keys: () => Promise.reject(new Error("boom")),
      open: () => Promise.reject(new Error("boom")),
    });
    expect(result).toEqual({ status: "not_collected", reason: "permission_missing" });
  });

  it("one unreadable cache does not drop the other caches", async () => {
    const caches: CacheStorageLike = {
      keys: () => Promise.resolve(["good", "bad"]),
      open: (name) =>
        name === "good"
          ? Promise.resolve({ keys: () => Promise.resolve([{ url: "https://a.test/x" }]) })
          : Promise.reject(new Error("boom")),
    };
    const result = await readCacheStorageCatalog(caches);
    if (result.status === "collected") {
      expect(result.value).toEqual([
        { cacheName: "good", entries: [{ requestUrl: "https://a.test/x" }] },
        { cacheName: "bad", entries: [] },
      ]);
    }
  });
});

describe("frame-level aggregate", () => {
  it("each domain degrades independently", async () => {
    const result = await readPageStorage({
      localStorage: () => {
        throw new Error("SecurityError");
      },
      sessionStorage: () => fakeStorage({ s: "1" }),
      indexedDb: undefined,
      caches: undefined,
    });
    expect(result.localStorage).toEqual({
      status: "not_collected",
      reason: "permission_missing",
    });
    expect(result.sessionStorage).toEqual({
      status: "collected",
      value: [{ key: "s", value: "1" }],
    });
    expect(result.indexedDbCatalog).toEqual({
      status: "not_collected",
      reason: "not_applicable",
    });
  });
});
