import { describe, expect, it } from "vitest";
import {
  applyStorageDiff,
  canonicalJson,
  computeSnapshotHash,
  diffStorageContent,
  normalizeStorageContent,
  verifyDiffReconstructs,
} from "../../src/core/storage-snapshot";
import type { CookieRecord, StorageSnapshotContent } from "../../src/schemas/storage";
import { storageSnapshotContentSchema } from "../../src/schemas/storage";

const cookie = (overrides: Partial<CookieRecord> = {}): CookieRecord => ({
  name: "sid",
  value: "abc",
  domain: "example.com",
  path: "/",
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  ...overrides,
});

const content = (overrides: Partial<StorageSnapshotContent> = {}): StorageSnapshotContent =>
  storageSnapshotContentSchema.parse({
    cookies: { status: "collected", value: [] },
    localStorage: { status: "collected", value: [] },
    sessionStorage: { status: "collected", value: [] },
    indexedDbCatalog: { status: "collected", value: [] },
    cacheStorageCatalog: { status: "collected", value: [] },
    ...overrides,
  });

describe("canonical serialization", () => {
  it("object key order does not change the serialization", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("nested key order is normalized too", () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe(
      canonicalJson({ outer: { a: 2, z: 1 } }),
    );
  });

  it("undefined members are dropped, matching JSON semantics", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});

describe("snapshotHash stability", () => {
  it("same state hashes identically across repeated computation", () => {
    const state = content({ cookies: { status: "collected", value: [cookie()] } });
    expect(computeSnapshotHash(state)).toBe(computeSnapshotHash(state));
  });

  it("cookie array order does not affect the hash", () => {
    const first = content({
      cookies: {
        status: "collected",
        value: [cookie({ name: "a" }), cookie({ name: "b" })],
      },
    });
    const second = content({
      cookies: {
        status: "collected",
        value: [cookie({ name: "b" }), cookie({ name: "a" })],
      },
    });
    expect(computeSnapshotHash(first)).toBe(computeSnapshotHash(second));
  });

  it("localStorage entry order does not affect the hash", () => {
    const first = content({
      localStorage: {
        status: "collected",
        value: [
          { key: "k1", value: "v1" },
          { key: "k2", value: "v2" },
        ],
      },
    });
    const second = content({
      localStorage: {
        status: "collected",
        value: [
          { key: "k2", value: "v2" },
          { key: "k1", value: "v1" },
        ],
      },
    });
    expect(computeSnapshotHash(first)).toBe(computeSnapshotHash(second));
  });

  it("a real value change does change the hash", () => {
    const before = content({ cookies: { status: "collected", value: [cookie({ value: "a" })] } });
    const after = content({ cookies: { status: "collected", value: [cookie({ value: "b" })] } });
    expect(computeSnapshotHash(before)).not.toBe(computeSnapshotHash(after));
  });

  it("not_collected never hashes the same as an empty collected set", () => {
    const empty = content({ cookies: { status: "collected", value: [] } });
    const missing = content({
      cookies: { status: "not_collected", reason: "permission_missing" },
    });
    expect(computeSnapshotHash(empty)).not.toBe(computeSnapshotHash(missing));
  });

  it("different not_collected reasons hash differently", () => {
    const denied = content({
      cookies: { status: "not_collected", reason: "permission_missing" },
    });
    const notApplicable = content({
      cookies: { status: "not_collected", reason: "not_applicable" },
    });
    expect(computeSnapshotHash(denied)).not.toBe(computeSnapshotHash(notApplicable));
  });

  it("normalization is idempotent", () => {
    const state = content({
      cookies: {
        status: "collected",
        value: [cookie({ name: "z" }), cookie({ name: "a" })],
      },
    });
    const once = normalizeStorageContent(state);
    expect(canonicalJson(normalizeStorageContent(once))).toBe(canonicalJson(once));
  });
});

describe("cookie metadata completeness", () => {
  it("HttpOnly / Secure / SameSite / Partitioned survive normalization and hashing", () => {
    const rich = cookie({
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      partitioned: true,
      expiresAt: 1_800_000_000,
    });
    const state = content({ cookies: { status: "collected", value: [rich] } });
    const normalized = normalizeStorageContent(state);
    expect(normalized.cookies).toMatchObject({ status: "collected" });
    if (normalized.cookies.status === "collected") {
      expect(normalized.cookies.value[0]).toMatchObject({
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        partitioned: true,
        expiresAt: 1_800_000_000,
      });
    }
  });

  it("partitioned true vs absent are distinct states", () => {
    const partitioned = content({
      cookies: { status: "collected", value: [cookie({ partitioned: true })] },
    });
    const plain = content({ cookies: { status: "collected", value: [cookie()] } });
    expect(computeSnapshotHash(partitioned)).not.toBe(computeSnapshotHash(plain));
  });

  it("cookies with the same name but different domain/path are distinct entries", () => {
    const state = content({
      cookies: {
        status: "collected",
        value: [
          cookie({ name: "sid", domain: "a.example.com", path: "/" }),
          cookie({ name: "sid", domain: "b.example.com", path: "/" }),
          cookie({ name: "sid", domain: "a.example.com", path: "/admin" }),
        ],
      },
    });
    const normalized = normalizeStorageContent(state);
    if (normalized.cookies.status === "collected") {
      expect(normalized.cookies.value).toHaveLength(3);
    }
  });
});

describe("diff computation", () => {
  const origin = "https://example.com";

  it("detects added / updated / removed cookies by (domain, path, name) identity", () => {
    const before = content({
      cookies: {
        status: "collected",
        value: [cookie({ name: "keep" }), cookie({ name: "drop" }), cookie({ name: "change", value: "old" })],
      },
    });
    const after = content({
      cookies: {
        status: "collected",
        value: [cookie({ name: "keep" }), cookie({ name: "change", value: "new" }), cookie({ name: "fresh" })],
      },
    });
    const diff = diffStorageContent(before, after, origin);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
    expect(diff.updated).toHaveLength(1);
    expect(diff.added[0]).toMatchObject({ entryKind: "cookie", cookie: { name: "fresh" } });
    expect(diff.removed[0]).toMatchObject({ entryKind: "cookie", cookie: { name: "drop" } });
    expect(diff.updated[0]).toMatchObject({
      entryKind: "cookie",
      before: { value: "old" },
      after: { value: "new" },
    });
  });

  it("detects key/value changes per storage area and tags them with the origin", () => {
    const before = content({
      localStorage: { status: "collected", value: [{ key: "a", value: "1" }] },
      sessionStorage: { status: "collected", value: [{ key: "s", value: "x" }] },
    });
    const after = content({
      localStorage: { status: "collected", value: [{ key: "a", value: "2" }] },
      sessionStorage: { status: "collected", value: [] },
    });
    const diff = diffStorageContent(before, after, origin);
    expect(diff.updated).toContainEqual({
      entryKind: "kv",
      area: "localStorage",
      origin,
      key: "a",
      valueBefore: "1",
      valueAfter: "2",
    });
    expect(diff.removed).toContainEqual({
      entryKind: "kv",
      area: "sessionStorage",
      origin,
      entry: { key: "s", value: "x" },
    });
  });

  it("an unchanged state produces an empty diff", () => {
    const state = content({
      cookies: { status: "collected", value: [cookie()] },
      localStorage: { status: "collected", value: [{ key: "a", value: "1" }] },
    });
    const diff = diffStorageContent(state, state, origin);
    expect(diff.added).toHaveLength(0);
    expect(diff.updated).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.skipped).toHaveLength(0);
  });

  it("diff entries are ordered deterministically regardless of input order", () => {
    const before = content({ cookies: { status: "collected", value: [] } });
    const afterA = content({
      cookies: {
        status: "collected",
        value: [cookie({ name: "z" }), cookie({ name: "a" })],
      },
    });
    const afterB = content({
      cookies: {
        status: "collected",
        value: [cookie({ name: "a" }), cookie({ name: "z" })],
      },
    });
    expect(canonicalJson(diffStorageContent(before, afterA, origin).added)).toBe(
      canonicalJson(diffStorageContent(before, afterB, origin).added),
    );
  });
});

describe("diff never fabricates changes out of a collection failure", () => {
  const origin = "https://example.com";

  it("skips a domain when the before side was not collected", () => {
    const before = content({
      cookies: { status: "not_collected", reason: "permission_missing" },
    });
    const after = content({ cookies: { status: "collected", value: [cookie()] } });
    const diff = diffStorageContent(before, after, origin);
    expect(diff.skipped).toContain("cookies");
    expect(diff.added).toHaveLength(0);
  });

  it("skips a domain when the after side was not collected — no phantom removals", () => {
    const before = content({ cookies: { status: "collected", value: [cookie()] } });
    const after = content({
      cookies: { status: "not_collected", reason: "missing_due_to_gap" },
    });
    const diff = diffStorageContent(before, after, origin);
    expect(diff.skipped).toContain("cookies");
    expect(diff.removed).toHaveLength(0);
  });

  it("reports each unreadable area separately", () => {
    const before = content({
      localStorage: { status: "not_collected", reason: "permission_missing" },
      sessionStorage: { status: "not_collected", reason: "not_applicable" },
    });
    const after = content();
    const diff = diffStorageContent(before, after, origin);
    expect(diff.skipped).toContain("localStorage");
    expect(diff.skipped).toContain("sessionStorage");
    expect(diff.skipped).not.toContain("cookies");
  });
});

describe("diff chain reconstructs the final state", () => {
  const origin = "https://example.com";

  it("initial + diff rebuilds final exactly", () => {
    const before = content({
      cookies: {
        status: "collected",
        value: [cookie({ name: "keep" }), cookie({ name: "drop" }), cookie({ name: "change", value: "old" })],
      },
      localStorage: {
        status: "collected",
        value: [
          { key: "a", value: "1" },
          { key: "gone", value: "x" },
        ],
      },
    });
    const after = content({
      cookies: {
        status: "collected",
        value: [cookie({ name: "keep" }), cookie({ name: "change", value: "new" }), cookie({ name: "fresh" })],
      },
      localStorage: {
        status: "collected",
        value: [
          { key: "a", value: "2" },
          { key: "added", value: "y" },
        ],
      },
    });
    const diff = diffStorageContent(before, after, origin);
    expect(verifyDiffReconstructs(before, diff, after)).toBe(true);
    expect(computeSnapshotHash(applyStorageDiff(before, diff))).toBe(computeSnapshotHash(after));
  });

  it("replaying a multi-step chain reaches the final state", () => {
    const step0 = content({ localStorage: { status: "collected", value: [] } });
    const step1 = content({
      localStorage: { status: "collected", value: [{ key: "a", value: "1" }] },
    });
    const step2 = content({
      localStorage: {
        status: "collected",
        value: [
          { key: "a", value: "1" },
          { key: "b", value: "2" },
        ],
      },
    });
    const step3 = content({
      localStorage: { status: "collected", value: [{ key: "b", value: "3" }] },
    });

    let rebuilt = step0;
    for (const [before, after] of [
      [step0, step1],
      [step1, step2],
      [step2, step3],
    ] as const) {
      rebuilt = applyStorageDiff(rebuilt, diffStorageContent(before, after, origin));
    }
    expect(computeSnapshotHash(rebuilt)).toBe(computeSnapshotHash(step3));
  });

  it("a tampered diff fails verification instead of silently passing", () => {
    const before = content({ localStorage: { status: "collected", value: [] } });
    const after = content({
      localStorage: { status: "collected", value: [{ key: "a", value: "1" }] },
    });
    const diff = diffStorageContent(before, after, origin);
    const tampered = { ...diff, added: [] };
    expect(verifyDiffReconstructs(before, tampered, after)).toBe(false);
  });

  it("not_collected domains pass through replay untouched", () => {
    const before = content({
      cookies: { status: "not_collected", reason: "permission_missing" },
      localStorage: { status: "collected", value: [] },
    });
    const after = content({
      cookies: { status: "not_collected", reason: "permission_missing" },
      localStorage: { status: "collected", value: [{ key: "a", value: "1" }] },
    });
    const diff = diffStorageContent(before, after, origin);
    const replayed = applyStorageDiff(before, diff);
    expect(replayed.cookies).toMatchObject({
      status: "not_collected",
      reason: "permission_missing",
    });
    expect(computeSnapshotHash(replayed)).toBe(computeSnapshotHash(after));
  });
});
