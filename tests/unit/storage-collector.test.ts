import { describe, expect, it } from "vitest";
import {
  StorageCollector,
  type FrameStorageTarget,
  type PageStorageRequester,
} from "../../src/background/storage-collector";
import type { CookieCollectionOptions } from "../../src/background/cookie-collector";
import { SCHEMA_VERSION } from "../../src/schemas/common";
import { sessionRecordSchema, type SessionRecord } from "../../src/schemas/session";
import type { EventEnvelope } from "../../src/schemas/event-envelope";
import type { PageStorageContent } from "../../src/schemas/storage";
import {
  captureEpochIdSchema,
  extFrameIdSchema,
  extTabIdSchema,
  sessionIdSchema,
  stepIdSchema,
} from "../../src/shared/ids";
import { defaultSessionConfig, T0 } from "../helpers/fixtures";

const SESSION_ID = sessionIdSchema.parse("ses_storage_test");
const TAB = extTabIdSchema.parse(1);
const MAIN_FRAME = extFrameIdSchema.parse(0);
const CHILD_FRAME = extFrameIdSchema.parse(7);
const STEP = stepIdSchema.parse("stp_test_1");

const session: SessionRecord = sessionRecordSchema.parse({
  schemaVersion: SCHEMA_VERSION,
  sessionId: SESSION_ID,
  lifecycle: "recording",
  captureQuality: "complete",
  startMode: "no_reload",
  originUrl: "https://example.com/",
  rootTabId: TAB,
  startedAt: T0,
  config: defaultSessionConfig(),
  captureEpochIds: [captureEpochIdSchema.parse("cap_1")],
});

const pageStorage = (
  overrides: Partial<PageStorageContent> = {},
): PageStorageContent => ({
  localStorage: { status: "collected", value: [] },
  sessionStorage: { status: "collected", value: [] },
  indexedDbCatalog: { status: "collected", value: [] },
  cacheStorageCatalog: { status: "collected", value: [] },
  ...overrides,
});

const grantedCookies = (names: readonly string[]): CookieCollectionOptions => ({
  permissions: { contains: () => Promise.resolve(true) },
  cookies: {
    getAll: () =>
      Promise.resolve(
        names.map((name) => ({
          name,
          value: `${name}-value`,
          domain: "example.com",
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax",
        })),
      ),
  },
});

interface CollectorHarness {
  readonly collector: StorageCollector;
  readonly envelopes: EventEnvelope[];
}

const makeCollector = (options: {
  frames: readonly FrameStorageTarget[];
  respond: PageStorageRequester;
  cookies?: CookieCollectionOptions;
  ingest?: (envelope: EventEnvelope) => Promise<unknown>;
}): CollectorHarness => {
  const envelopes: EventEnvelope[] = [];
  let clock = T0;
  const collector = new StorageCollector({
    cookies: options.cookies ?? grantedCookies(["sid"]),
    requestPageStorage: options.respond,
    listFrames: () => Promise.resolve(options.frames),
    ingest: options.ingest ?? ((envelope) => {
      envelopes.push(envelope);
      return Promise.resolve({
        status: "committed",
        eventId: envelope.eventId,
        committedBytes: 1,
      });
    }),
    now: () => clock++,
  });
  return { collector, envelopes };
};

const snapshotsIn = (envelopes: readonly EventEnvelope[]) =>
  envelopes.filter((envelope) => envelope.payload.kind === "storage_snapshot");

const diffsIn = (envelopes: readonly EventEnvelope[]) =>
  envelopes.filter((envelope) => envelope.payload.kind === "storage_diff");

describe("frame isolation", () => {
  it("two frames with the same sessionStorage key are recorded separately", async () => {
    const { collector, envelopes } = makeCollector({
      frames: [
        { tabId: TAB, frameId: MAIN_FRAME },
        { tabId: TAB, frameId: CHILD_FRAME },
      ],
      respond: (target) =>
        Promise.resolve({
          origin:
            target.frameId === MAIN_FRAME ? "https://example.com" : "https://widget.other.test",
          content: pageStorage({
            sessionStorage: {
              status: "collected",
              value: [
                {
                  key: "token",
                  value: target.frameId === MAIN_FRAME ? "main-token" : "child-token",
                },
              ],
            },
          }),
        }),
    });

    await collector.start({ session });
    const snapshots = snapshotsIn(envelopes);
    expect(snapshots).toHaveLength(2);

    const byFrame = new Map(
      snapshots.map((envelope) => {
        const record = (envelope.payload as { record: Record<string, unknown> }).record;
        return [record.frameId as number, record];
      }),
    );
    const main = byFrame.get(MAIN_FRAME) as { content: PageStorageContent; origin: string };
    const child = byFrame.get(CHILD_FRAME) as { content: PageStorageContent; origin: string };

    expect(main.origin).toBe("https://example.com");
    expect(child.origin).toBe("https://widget.other.test");
    if (
      main.content.sessionStorage.status === "collected" &&
      child.content.sessionStorage.status === "collected"
    ) {
      expect(main.content.sessionStorage.value).toEqual([{ key: "token", value: "main-token" }]);
      expect(child.content.sessionStorage.value).toEqual([
        { key: "token", value: "child-token" },
      ]);
    }
  });

  it("each frame's snapshot hash reflects only its own storage", async () => {
    const { collector, envelopes } = makeCollector({
      frames: [
        { tabId: TAB, frameId: MAIN_FRAME },
        { tabId: TAB, frameId: CHILD_FRAME },
      ],
      respond: (target) =>
        Promise.resolve({
          origin: "https://example.com",
          content: pageStorage({
            localStorage: {
              status: "collected",
              value: [{ key: "k", value: target.frameId === MAIN_FRAME ? "a" : "b" }],
            },
          }),
        }),
    });
    await collector.start({ session });
    const hashes = snapshotsIn(envelopes).map(
      (envelope) => (envelope.payload as { record: { snapshotHash: string } }).record.snapshotHash,
    );
    expect(new Set(hashes).size).toBe(2);
  });
});

describe("cookie ownership", () => {
  it("only the main frame carries the cookie jar view", async () => {
    const { collector, envelopes } = makeCollector({
      frames: [
        { tabId: TAB, frameId: MAIN_FRAME },
        { tabId: TAB, frameId: CHILD_FRAME },
      ],
      respond: () =>
        Promise.resolve({ origin: "https://example.com", content: pageStorage() }),
    });
    await collector.start({ session });
    const records = snapshotsIn(envelopes).map(
      (envelope) =>
        (envelope.payload as { record: { frameId: number; content: { cookies: unknown } } }).record,
    );
    const main = records.find((record) => record.frameId === MAIN_FRAME);
    const child = records.find((record) => record.frameId === CHILD_FRAME);
    expect(main?.content.cookies).toMatchObject({ status: "collected" });
    expect(child?.content.cookies).toEqual({
      status: "not_collected",
      reason: "not_applicable",
    });
  });

  it("an unauthorized origin records not_applicable cookies, not an empty jar", async () => {
    const { collector, envelopes } = makeCollector({
      frames: [{ tabId: TAB, frameId: MAIN_FRAME }],
      respond: () =>
        Promise.resolve({ origin: "https://example.com", content: pageStorage() }),
      cookies: {
        permissions: { contains: () => Promise.resolve(false) },
        cookies: { getAll: () => Promise.resolve([]) },
      },
    });
    await collector.start({ session });
    const record = (snapshotsIn(envelopes)[0]?.payload as { record: { content: { cookies: unknown } } })
      .record;
    expect(record.content.cookies).toEqual({
      status: "not_collected",
      reason: "not_applicable",
    });
  });
});

describe("unreachable frames never become empty snapshots", () => {
  it("a frame that does not answer is recorded as a gap across every domain", async () => {
    const { collector, envelopes } = makeCollector({
      frames: [{ tabId: TAB, frameId: MAIN_FRAME }],
      respond: () => Promise.resolve(null),
    });
    await collector.start({ session });
    const record = (
      snapshotsIn(envelopes)[0]?.payload as {
        record: { content: PageStorageContent };
      }
    ).record;
    expect(record.content.localStorage).toEqual({
      status: "not_collected",
      reason: "missing_due_to_gap",
    });
    expect(record.content.sessionStorage).toEqual({
      status: "not_collected",
      reason: "missing_due_to_gap",
    });
  });

  it("a rejected request is treated the same as no answer", async () => {
    const { collector, envelopes } = makeCollector({
      frames: [{ tabId: TAB, frameId: MAIN_FRAME }],
      respond: () => Promise.reject(new Error("frame gone")),
    });
    await collector.start({ session });
    const record = (
      snapshotsIn(envelopes)[0]?.payload as { record: { content: PageStorageContent } }
    ).record;
    expect(record.content.indexedDbCatalog).toEqual({
      status: "not_collected",
      reason: "missing_due_to_gap",
    });
  });
});

describe("snapshot roles and step diffs", () => {
  const respondWith = (values: Map<string, string>): PageStorageRequester =>
    () =>
      Promise.resolve({
        origin: "https://example.com",
        content: pageStorage({
          localStorage: {
            status: "collected",
            value: [...values.entries()].map(([key, value]) => ({ key, value })),
          },
        }),
      });

  it("start records an initial snapshot and stop records a final one", async () => {
    const values = new Map([["k", "v1"]]);
    const { collector, envelopes } = makeCollector({
      frames: [{ tabId: TAB, frameId: MAIN_FRAME }],
      respond: respondWith(values),
    });
    await collector.start({ session });
    await collector.stop(SESSION_ID);
    const roles = snapshotsIn(envelopes).map(
      (envelope) => (envelope.payload as { record: { role: string } }).record.role,
    );
    expect(roles).toEqual(["initial", "final"]);
  });

  it("emits a diff describing what changed during the step", async () => {
    const values = new Map([["k", "v1"]]);
    const { collector, envelopes } = makeCollector({
      frames: [{ tabId: TAB, frameId: MAIN_FRAME }],
      respond: respondWith(values),
    });
    await collector.start({ session });
    values.set("k", "v2");
    values.set("added", "new");

    const recordId = await collector.captureStepDiff(SESSION_ID, STEP);
    expect(recordId).not.toBeNull();

    const diff = (diffsIn(envelopes)[0]?.payload as {
      record: {
        observedDuringStepId: string;
        added: readonly unknown[];
        updated: readonly unknown[];
        removed: readonly unknown[];
      };
    }).record;
    expect(diff.observedDuringStepId).toBe(STEP);
    expect(diff.updated).toHaveLength(1);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(0);
  });

  it("an unchanged step writes no diff record at all", async () => {
    const values = new Map([["k", "v1"]]);
    const { collector, envelopes } = makeCollector({
      frames: [{ tabId: TAB, frameId: MAIN_FRAME }],
      respond: respondWith(values),
    });
    await collector.start({ session });
    const recordId = await collector.captureStepDiff(SESSION_ID, STEP);
    expect(recordId).toBeNull();
    expect(diffsIn(envelopes)).toHaveLength(0);
  });

  it("carries in-flight request keys as observation context", async () => {
    const values = new Map([["k", "v1"]]);
    const { collector, envelopes } = makeCollector({
      frames: [{ tabId: TAB, frameId: MAIN_FRAME }],
      respond: respondWith(values),
    });
    await collector.start({ session });
    values.set("k", "v2");
    await collector.captureStepDiff(SESSION_ID, STEP, ["req-1", "req-2"]);
    const diff = (diffsIn(envelopes)[0]?.payload as {
      record: { inFlightRequestKeys: readonly string[] };
    }).record;
    expect(diff.inFlightRequestKeys).toEqual(["req-1", "req-2"]);
  });

  it("a frame appearing mid-session is not reported as a burst of additions", async () => {
    const frames: FrameStorageTarget[] = [{ tabId: TAB, frameId: MAIN_FRAME }];
    const envelopes: EventEnvelope[] = [];
    let clock = T0;
    const collector = new StorageCollector({
      cookies: grantedCookies(["sid"]),
      requestPageStorage: (target) =>
        Promise.resolve({
          origin: "https://example.com",
          content: pageStorage({
            localStorage: {
              status: "collected",
              value: [{ key: `frame-${String(target.frameId)}`, value: "x" }],
            },
          }),
        }),
      listFrames: () => Promise.resolve([...frames]),
      ingest: (envelope) => {
        envelopes.push(envelope);
        return Promise.resolve({
          status: "committed",
          eventId: envelope.eventId,
          committedBytes: 1,
        });
      },
      now: () => clock++,
    });

    await collector.start({ session });
    frames.push({ tabId: TAB, frameId: CHILD_FRAME });
    const recordId = await collector.captureStepDiff(SESSION_ID, STEP);

    expect(recordId).toBeNull();
    expect(diffsIn(envelopes)).toHaveLength(0);
  });

  it("disconnect drops baselines without reading storage again", async () => {
    let reads = 0;
    const { collector } = makeCollector({
      frames: [{ tabId: TAB, frameId: MAIN_FRAME }],
      respond: () => {
        reads += 1;
        return Promise.resolve({ origin: "https://example.com", content: pageStorage() });
      },
    });
    await collector.start({ session });
    const afterStart = reads;
    await collector.disconnect(SESSION_ID);
    await collector.stop(SESSION_ID);
    expect(reads).toBe(afterStart);
  });
});

describe("initial snapshot persistence ACK", () => {
  it("rejects collector startup when an initial snapshot fact is rejected", async () => {
    let reads = 0;
    const { collector } = makeCollector({
      frames: [{ tabId: TAB, frameId: MAIN_FRAME }],
      respond: () => {
        reads += 1;
        return Promise.resolve({ origin: "https://example.com", content: pageStorage() });
      },
      ingest: (envelope) =>
        Promise.resolve({
          status: "rejected",
          eventId: envelope.eventId,
          errorCode: "SESSION_NOT_ACCEPTING_FACTS",
          retryable: false,
        }),
    });

    await expect(collector.start({ session })).resolves.toMatchObject({
      ok: false,
      error: { code: "SESSION_NOT_ACCEPTING_FACTS" },
    });
    const afterStart = reads;
    await collector.stop(SESSION_ID);
    expect(reads).toBe(afterStart);
  });

  it("rejects collector startup when persistence returns a malformed ACK", async () => {
    const { collector } = makeCollector({
      frames: [{ tabId: TAB, frameId: MAIN_FRAME }],
      respond: () =>
        Promise.resolve({ origin: "https://example.com", content: pageStorage() }),
      ingest: () => Promise.resolve(undefined),
    });

    await expect(collector.start({ session })).resolves.toMatchObject({
      ok: false,
      error: { code: "PERSISTENCE_TRANSACTION_FAILED" },
    });
  });
});
