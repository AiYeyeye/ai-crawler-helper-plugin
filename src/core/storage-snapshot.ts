import type {
  CookieRecord,
  KeyValueEntry,
  StorageArea,
  StorageDiffEntry,
  StorageSnapshotContent,
  StorageUpdatedEntry,
} from "../schemas/storage";

/**
 * Storage snapshot canonicalization, hashing and diffing (design 10).
 *
 * Pure functions only — no chrome APIs, no I/O. The collector layer supplies
 * already-read content; this module decides what "changed" means and produces
 * a hash that is stable for an identical state regardless of the order the
 * browser happened to return entries in.
 */

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * Recursively sort object keys so that key ordering can never produce a
 * different hash for the same logical state. Array order is preserved here —
 * arrays are ordered deliberately by `normalizeStorageContent` first.
 */
export const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const sorted = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => compareStrings(left, right));
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of sorted) {
      result[key] = canonicalize(entryValue);
    }
    return result;
  }
  return value;
};

export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

// ---------------------------------------------------------------------------
// Stable hash
// ---------------------------------------------------------------------------

const FNV_PRIME = 0x01000193;
/** Four independent offset bases → 4×32 bits = 128-bit digest. */
const FNV_SEEDS = [0x811c9dc5, 0x1000193, 0x7fffffff, 0x9e3779b9] as const;

const fnv1a32 = (bytes: Uint8Array, seed: number): number => {
  let hash = seed >>> 0;
  for (const byte of bytes) {
    hash = (hash ^ byte) >>> 0;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
};

/**
 * Deterministic, dependency-free digest of a string. Not a cryptographic
 * primitive — its contract is stability (same input ⇒ same output, in any
 * runtime), which is what snapshot-chain verification needs.
 */
export const stableHash = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  return FNV_SEEDS.map((seed) => fnv1a32(bytes, seed).toString(16).padStart(8, "0")).join("");
};

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Identity of a cookie per RFC 6265: name + domain + path. */
export const cookieIdentity = (cookie: CookieRecord): string =>
  JSON.stringify([cookie.domain, cookie.path, cookie.name]);

const compareCookies = (left: CookieRecord, right: CookieRecord): number =>
  compareStrings(cookieIdentity(left), cookieIdentity(right));

const compareByKey = (left: KeyValueEntry, right: KeyValueEntry): number =>
  compareStrings(left.key, right.key);

/**
 * Order every collection deterministically. Browsers do not guarantee the order
 * of `chrome.cookies.getAll` or `Object.keys(localStorage)`, so an unsorted
 * snapshot would hash differently on every read of an unchanged state.
 */
export const normalizeStorageContent = (
  content: StorageSnapshotContent,
): StorageSnapshotContent => ({
  cookies:
    content.cookies.status === "collected"
      ? { status: "collected", value: [...content.cookies.value].sort(compareCookies) }
      : content.cookies,
  localStorage:
    content.localStorage.status === "collected"
      ? { status: "collected", value: [...content.localStorage.value].sort(compareByKey) }
      : content.localStorage,
  sessionStorage:
    content.sessionStorage.status === "collected"
      ? { status: "collected", value: [...content.sessionStorage.value].sort(compareByKey) }
      : content.sessionStorage,
  indexedDbCatalog:
    content.indexedDbCatalog.status === "collected"
      ? {
          status: "collected",
          value: [...content.indexedDbCatalog.value]
            .sort((left, right) => compareStrings(left.databaseName, right.databaseName))
            .map((database) => ({
              ...database,
              objectStores: [...database.objectStores]
                .sort((left, right) => compareStrings(left.name, right.name))
                .map((store) => ({ ...store, indexNames: [...store.indexNames].sort(compareStrings) })),
            })),
        }
      : content.indexedDbCatalog,
  cacheStorageCatalog:
    content.cacheStorageCatalog.status === "collected"
      ? {
          status: "collected",
          value: [...content.cacheStorageCatalog.value]
            .sort((left, right) => compareStrings(left.cacheName, right.cacheName))
            .map((cache) => ({
              ...cache,
              entries: [...cache.entries].sort((left, right) =>
                compareStrings(left.requestUrl, right.requestUrl),
              ),
            })),
        }
      : content.cacheStorageCatalog,
});

/**
 * Stable hash of a storage state. `not_collected` domains participate in the
 * hash via their reason, so "could not read cookies" never hashes the same as
 * "there were no cookies".
 */
export const computeSnapshotHash = (content: StorageSnapshotContent): string =>
  stableHash(canonicalJson(normalizeStorageContent(content)));

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export interface StorageDiffResult {
  readonly added: StorageDiffEntry[];
  readonly updated: StorageUpdatedEntry[];
  readonly removed: StorageDiffEntry[];
  /**
   * Domains skipped because at least one side was `not_collected`. A domain
   * here produced NO diff entries — absence of entries must not be read as
   * "nothing changed".
   */
  readonly skipped: readonly ("cookies" | StorageArea)[];
}

const cookieChanged = (before: CookieRecord, after: CookieRecord): boolean =>
  canonicalJson(before) !== canonicalJson(after);

const indexBy = <T>(items: readonly T[], key: (item: T) => string): Map<string, T> => {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(key(item), item);
  }
  return map;
};

/**
 * Compute added/updated/removed between two snapshots of the SAME origin+frame.
 *
 * A domain is diffed only when both sides were actually collected. Diffing a
 * collected side against a `not_collected` side would fabricate a full
 * add/remove set out of a permission or gap event.
 */
export const diffStorageContent = (
  before: StorageSnapshotContent,
  after: StorageSnapshotContent,
  origin: string,
): StorageDiffResult => {
  const added: StorageDiffEntry[] = [];
  const updated: StorageUpdatedEntry[] = [];
  const removed: StorageDiffEntry[] = [];
  const skipped: ("cookies" | StorageArea)[] = [];

  if (before.cookies.status === "collected" && after.cookies.status === "collected") {
    const beforeCookies = indexBy(before.cookies.value, cookieIdentity);
    const afterCookies = indexBy(after.cookies.value, cookieIdentity);
    for (const [identity, afterCookie] of afterCookies) {
      const beforeCookie = beforeCookies.get(identity);
      if (beforeCookie === undefined) {
        added.push({ entryKind: "cookie", cookie: afterCookie });
      } else if (cookieChanged(beforeCookie, afterCookie)) {
        updated.push({ entryKind: "cookie", before: beforeCookie, after: afterCookie });
      }
    }
    for (const [identity, beforeCookie] of beforeCookies) {
      if (!afterCookies.has(identity)) {
        removed.push({ entryKind: "cookie", cookie: beforeCookie });
      }
    }
  } else {
    skipped.push("cookies");
  }

  for (const area of ["localStorage", "sessionStorage"] as const) {
    const beforeArea = before[area];
    const afterArea = after[area];
    if (beforeArea.status !== "collected" || afterArea.status !== "collected") {
      skipped.push(area);
      continue;
    }
    const beforeEntries = indexBy(beforeArea.value, (entry) => entry.key);
    const afterEntries = indexBy(afterArea.value, (entry) => entry.key);
    for (const [key, afterEntry] of afterEntries) {
      const beforeEntry = beforeEntries.get(key);
      if (beforeEntry === undefined) {
        added.push({ entryKind: "kv", area, origin, entry: afterEntry });
      } else if (beforeEntry.value !== afterEntry.value) {
        updated.push({
          entryKind: "kv",
          area,
          origin,
          key,
          valueBefore: beforeEntry.value,
          valueAfter: afterEntry.value,
        });
      }
    }
    for (const [key, beforeEntry] of beforeEntries) {
      if (!afterEntries.has(key)) {
        removed.push({ entryKind: "kv", area, origin, entry: beforeEntry });
      }
    }
  }

  return {
    added: sortDiffEntries(added),
    updated: sortUpdatedEntries(updated),
    removed: sortDiffEntries(removed),
    skipped,
  };
};

const diffEntrySortKey = (entry: StorageDiffEntry): string =>
  entry.entryKind === "cookie"
    ? `cookie ${cookieIdentity(entry.cookie)}`
    : `kv ${entry.area} ${entry.origin} ${entry.entry.key}`;

const updatedEntrySortKey = (entry: StorageUpdatedEntry): string =>
  entry.entryKind === "cookie"
    ? `cookie ${cookieIdentity(entry.after)}`
    : `kv ${entry.area} ${entry.origin} ${entry.key}`;

const sortDiffEntries = (entries: StorageDiffEntry[]): StorageDiffEntry[] =>
  [...entries].sort((left, right) => compareStrings(diffEntrySortKey(left), diffEntrySortKey(right)));

const sortUpdatedEntries = (entries: StorageUpdatedEntry[]): StorageUpdatedEntry[] =>
  [...entries].sort((left, right) =>
    compareStrings(updatedEntrySortKey(left), updatedEntrySortKey(right)),
  );

// ---------------------------------------------------------------------------
// Replay (diff chain verification)
// ---------------------------------------------------------------------------

export interface StorageDiffApplication {
  readonly added: readonly StorageDiffEntry[];
  readonly updated: readonly StorageUpdatedEntry[];
  readonly removed: readonly StorageDiffEntry[];
}

/**
 * Replay a diff onto a snapshot. Used to verify that `initial + diffs` really
 * reconstructs `final` — if it does not, the recorded diff chain is wrong and
 * the session must be reported as degraded rather than silently exported.
 *
 * Domains that were `not_collected` are passed through untouched: a diff never
 * carries entries for them (see `diffStorageContent`).
 */
export const applyStorageDiff = (
  base: StorageSnapshotContent,
  diff: StorageDiffApplication,
): StorageSnapshotContent => {
  const next = normalizeStorageContent(base);

  const cookies =
    next.cookies.status === "collected" ? indexBy(next.cookies.value, cookieIdentity) : null;
  const areas: Record<StorageArea, Map<string, KeyValueEntry> | null> = {
    localStorage:
      next.localStorage.status === "collected"
        ? indexBy(next.localStorage.value, (entry) => entry.key)
        : null,
    sessionStorage:
      next.sessionStorage.status === "collected"
        ? indexBy(next.sessionStorage.value, (entry) => entry.key)
        : null,
  };

  for (const entry of diff.removed) {
    if (entry.entryKind === "cookie") {
      cookies?.delete(cookieIdentity(entry.cookie));
    } else {
      areas[entry.area]?.delete(entry.entry.key);
    }
  }
  for (const entry of diff.added) {
    if (entry.entryKind === "cookie") {
      cookies?.set(cookieIdentity(entry.cookie), entry.cookie);
    } else {
      areas[entry.area]?.set(entry.entry.key, entry.entry);
    }
  }
  for (const entry of diff.updated) {
    if (entry.entryKind === "cookie") {
      cookies?.set(cookieIdentity(entry.after), entry.after);
    } else {
      areas[entry.area]?.set(entry.key, { key: entry.key, value: entry.valueAfter });
    }
  }

  return normalizeStorageContent({
    ...next,
    cookies:
      cookies === null ? next.cookies : { status: "collected", value: [...cookies.values()] },
    localStorage:
      areas.localStorage === null
        ? next.localStorage
        : { status: "collected", value: [...areas.localStorage.values()] },
    sessionStorage:
      areas.sessionStorage === null
        ? next.sessionStorage
        : { status: "collected", value: [...areas.sessionStorage.values()] },
  });
};

/**
 * True when replaying `diff` onto `before` reproduces `after` exactly
 * (hash-compared on the canonical form).
 */
export const verifyDiffReconstructs = (
  before: StorageSnapshotContent,
  diff: StorageDiffApplication,
  after: StorageSnapshotContent,
): boolean => computeSnapshotHash(applyStorageDiff(before, diff)) === computeSnapshotHash(after);
