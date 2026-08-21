import type {
  CaptureCollector,
  CollectorStartContext,
  CollectorStartResult,
} from "../core/collector-contracts";
import {
  computeSnapshotHash,
  diffStorageContent,
  type StorageDiffResult,
} from "../core/storage-snapshot";
import { collectCookiesForOrigin, type CookieCollectionOptions } from "./cookie-collector";
import { SCHEMA_VERSION } from "../schemas/common";
import {
  envelopeAckSchema,
  eventEnvelopeSchema,
  type EventEnvelope,
} from "../schemas/event-envelope";
import {
  storageDiffRecordSchema,
  storageSnapshotRecordSchema,
  type PageStorageContent,
  type StorageDiffEntry,
  type StorageSnapshotContent,
  type StorageUpdatedEntry,
} from "../schemas/storage";
import { PROTOCOL_VERSION, type CollectPageStorageResponse } from "../shared/messages";
import { businessErrorCodeSchema, businessError, type BusinessError } from "../shared/errors";
import {
  newEventId,
  newStorageRecordId,
  type EventId,
  type ExtFrameId,
  type ExtTabId,
  type SessionId,
  type StepId,
  type StorageRecordId,
} from "../shared/ids";

/**
 * Cookie + page storage collection across a session's frames (design 10/11).
 *
 * Division of labour: cookies are readable only by the Service Worker
 * (`chrome.cookies`), page storage only by the frame that owns it. This
 * collector asks each frame for its own storage and never merges areas across
 * frames — that is what keeps `sessionStorage` isolated.
 */

export interface FrameStorageTarget {
  readonly tabId: ExtTabId;
  readonly frameId: ExtFrameId;
}

/** Sends `content/collectPageStorage` to one frame. */
export type PageStorageRequester = (
  target: FrameStorageTarget,
  sessionId: SessionId,
) => Promise<CollectPageStorageResponse | null>;

export interface StorageCollectorOptions {
  readonly cookies: CookieCollectionOptions;
  /**
   * Per-session extra cookie origins (`SessionConfig.extraCookieDomains`).
   * Resolved at read time so a session always uses the domains it started
   * with, rather than whatever the collector was constructed with.
   */
  readonly additionalCookieOriginsFor?: (
    sessionId: SessionId,
  ) => Promise<readonly string[]>;
  readonly requestPageStorage: PageStorageRequester;
  /** Frames currently participating in the session. */
  readonly listFrames: (sessionId: SessionId) => Promise<readonly FrameStorageTarget[]>;
  readonly ingest: (envelope: EventEnvelope) => Promise<unknown>;
  readonly newEventId?: () => EventId;
  readonly newStorageRecordId?: () => StorageRecordId;
  readonly now?: () => number;
}

/** Main frame owns the cookie jar view; sub-frames report cookies as N/A. */
const MAIN_FRAME_ID = 0;

/** A page-storage read that failed entirely, per domain. */
const unreadablePageStorage = (
  reason: "permission_missing" | "not_applicable" | "missing_due_to_gap",
): PageStorageContent => ({
  localStorage: { status: "not_collected", reason },
  sessionStorage: { status: "not_collected", reason },
  indexedDbCatalog: { status: "not_collected", reason },
  cacheStorageCatalog: { status: "not_collected", reason },
});

interface FrameSnapshot {
  readonly origin: string;
  readonly content: StorageSnapshotContent;
}

const frameKey = (target: FrameStorageTarget): string =>
  JSON.stringify([target.tabId, target.frameId]);

export class StorageCollector implements CaptureCollector {
  readonly name = "storage" as const;

  private readonly options: StorageCollectorOptions;
  private readonly makeEventId: () => EventId;
  private readonly makeRecordId: () => StorageRecordId;
  private readonly now: () => number;
  /** Last observed content per session/frame, the baseline for the next diff. */
  private readonly baseline = new Map<SessionId, Map<string, FrameSnapshot>>();
  /** Resume preparation reads storage while the durable fact gate remains closed. */
  private readonly preparedInitial = new Map<SessionId, Map<string, FrameSnapshot>>();
  private sourceSeq = 0;

  constructor(options: StorageCollectorOptions) {
    this.options = options;
    this.makeEventId = options.newEventId ?? newEventId;
    this.makeRecordId = options.newStorageRecordId ?? newStorageRecordId;
    this.now = options.now ?? (() => Date.now());
  }

  async start(context: CollectorStartContext): Promise<CollectorStartResult> {
    const prepared = await this.prepare(context);
    return prepared.ok ? this.activate(context) : prepared;
  }

  async prepare(context: CollectorStartContext): Promise<CollectorStartResult> {
    try {
      this.preparedInitial.set(
        context.session.sessionId,
        await this.readAllFrames(context.session.sessionId),
      );
      return { ok: true };
    } catch (cause: unknown) {
      return { ok: false, error: storageStartError(cause, context.session.sessionId) };
    }
  }

  async activate(context: CollectorStartContext): Promise<CollectorStartResult> {
    const sessionId = context.session.sessionId;
    const frames = this.preparedInitial.get(sessionId);
    if (frames === undefined) {
      return {
        ok: false,
        error: businessError(
          "PERSISTENCE_TRANSACTION_FAILED",
          "storage collector activation has no prepared initial snapshot",
          { sessionId },
        ),
      };
    }
    try {
      await this.persistSnapshots(sessionId, "initial", frames);
      this.baseline.set(sessionId, frames);
      this.preparedInitial.delete(sessionId);
      return { ok: true };
    } catch (cause: unknown) {
      this.preparedInitial.delete(sessionId);
      this.baseline.delete(sessionId);
      return { ok: false, error: storageStartError(cause, sessionId) };
    }
  }

  async stop(sessionId: SessionId): Promise<void> {
    if (!this.baseline.has(sessionId)) {
      return;
    }
    await this.captureSnapshots(sessionId, "final");
    this.baseline.delete(sessionId);
  }

  /** Hard disconnect: drop baselines without attempting more page reads. */
  disconnect(sessionId: SessionId): Promise<void> {
    this.baseline.delete(sessionId);
    this.preparedInitial.delete(sessionId);
    return Promise.resolve();
  }

  /**
   * Snapshot every frame and emit one diff record for the step that just ended.
   * Returns null when nothing changed, so an unchanged step writes no record.
   */
  async captureStepDiff(
    sessionId: SessionId,
    stepId: StepId,
    inFlightRequestKeys: readonly string[] = [],
  ): Promise<StorageRecordId | null> {
    const previous = this.baseline.get(sessionId) ?? new Map<string, FrameSnapshot>();
    const current = await this.readAllFrames(sessionId);

    const added: StorageDiffEntry[] = [];
    const updated: StorageUpdatedEntry[] = [];
    const removed: StorageDiffEntry[] = [];

    for (const [key, snapshot] of current) {
      const before = previous.get(key);
      if (before === undefined) {
        // A frame appearing mid-session has no baseline to diff against; its
        // state is captured as the new baseline, not reported as N additions.
        continue;
      }
      const diff: StorageDiffResult = diffStorageContent(
        before.content,
        snapshot.content,
        snapshot.origin,
      );
      added.push(...diff.added);
      updated.push(...diff.updated);
      removed.push(...diff.removed);
    }

    this.baseline.set(sessionId, current);

    if (added.length === 0 && updated.length === 0 && removed.length === 0) {
      return null;
    }

    const recordedAt = this.now();
    const storageRecordId = this.makeRecordId();
    const record = storageDiffRecordSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      storageRecordId,
      sessionId,
      observedDuringStepId: stepId,
      inFlightRequestKeys: [...inFlightRequestKeys],
      added,
      updated,
      removed,
      snapshotHash: computeSnapshotHash(mergedContentOf(current)),
      recordedAt,
    });
    await this.emit(sessionId, recordedAt, { kind: "storage_diff", record });
    return storageRecordId;
  }

  private async captureSnapshots(
    sessionId: SessionId,
    role: "initial" | "final",
  ): Promise<void> {
    const frames = await this.readAllFrames(sessionId);
    await this.persistSnapshots(sessionId, role, frames);
    this.baseline.set(sessionId, frames);
  }

  private async persistSnapshots(
    sessionId: SessionId,
    role: "initial" | "final",
    frames: ReadonlyMap<string, FrameSnapshot>,
  ): Promise<void> {
    for (const [key, snapshot] of frames) {
      const target = JSON.parse(key) as [ExtTabId, ExtFrameId];
      const recordedAt = this.now();
      const record = storageSnapshotRecordSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        storageRecordId: this.makeRecordId(),
        sessionId,
        role,
        origin: snapshot.origin,
        tabId: target[0],
        frameId: target[1],
        content: snapshot.content,
        snapshotHash: computeSnapshotHash(snapshot.content),
        recordedAt,
      });
      await this.emit(sessionId, recordedAt, { kind: "storage_snapshot", record }, target[0]);
    }
  }

  private async readAllFrames(sessionId: SessionId): Promise<Map<string, FrameSnapshot>> {
    const result = new Map<string, FrameSnapshot>();
    let frames: readonly FrameStorageTarget[];
    try {
      frames = await this.options.listFrames(sessionId);
    } catch {
      return result;
    }
    for (const frame of frames) {
      result.set(frameKey(frame), await this.readFrame(frame, sessionId));
    }
    return result;
  }

  private async readFrame(
    frame: FrameStorageTarget,
    sessionId: SessionId,
  ): Promise<FrameSnapshot> {
    let response: CollectPageStorageResponse | null;
    try {
      response = await this.options.requestPageStorage(frame, sessionId);
    } catch {
      response = null;
    }

    // An unreachable frame yields explicit gaps, never an empty snapshot.
    const origin = response?.origin ?? "null";
    const pageStorage = response?.content ?? unreadablePageStorage("missing_due_to_gap");

    const cookies =
      frame.frameId === MAIN_FRAME_ID && response !== null
        ? await collectCookiesForOrigin(origin, await this.cookieOptionsFor(sessionId))
        : ({ status: "not_collected", reason: "not_applicable" } as const);

    return { origin, content: { ...pageStorage, cookies } };
  }

  /** Session-scoped cookie options: base APIs + the session's extra origins. */
  private async cookieOptionsFor(sessionId: SessionId): Promise<CookieCollectionOptions> {
    const resolve = this.options.additionalCookieOriginsFor;
    if (resolve === undefined) {
      return this.options.cookies;
    }
    let extra: readonly string[];
    try {
      extra = await resolve(sessionId);
    } catch {
      // A settings lookup failure must not silently widen or narrow the read.
      return this.options.cookies;
    }
    return { ...this.options.cookies, additionalOrigins: extra };
  }

  private async emit(
    sessionId: SessionId,
    sourceTimestamp: number,
    payload: { kind: "storage_snapshot" | "storage_diff"; record: unknown },
    tabId?: ExtTabId,
  ): Promise<void> {
    const envelope = eventEnvelopeSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      eventId: this.makeEventId(),
      source: "service_worker",
      sourceSeq: this.sourceSeq++,
      sessionId,
      scope: tabId === undefined ? {} : { tabId },
      sourceTimestamp,
      payload,
    });
    const parsed = envelopeAckSchema.safeParse(await this.options.ingest(envelope));
    if (!parsed.success || parsed.data.eventId !== envelope.eventId) {
      throw new StorageCollectorPersistenceError(
        businessError(
          "PERSISTENCE_TRANSACTION_FAILED",
          "storage fact persistence returned an invalid acknowledgement",
          { sessionId, eventId: envelope.eventId },
        ),
      );
    }
    if (parsed.data.status === "rejected") {
      const code = businessErrorCodeSchema.safeParse(parsed.data.errorCode);
      throw new StorageCollectorPersistenceError(
        businessError(
          code.success ? code.data : "PERSISTENCE_TRANSACTION_FAILED",
          `storage fact persistence rejected: ${parsed.data.errorCode}`,
          { sessionId, eventId: envelope.eventId, retryable: parsed.data.retryable },
        ),
      );
    }
  }
}

class StorageCollectorPersistenceError extends Error {
  constructor(readonly businessError: BusinessError) {
    super(businessError.message);
    this.name = "StorageCollectorPersistenceError";
  }
}

const storageStartError = (cause: unknown, sessionId: SessionId): BusinessError =>
  cause instanceof StorageCollectorPersistenceError
    ? cause.businessError
    : businessError(
        "PERSISTENCE_TRANSACTION_FAILED",
        "storage collector initial snapshot preparation failed",
        { sessionId },
      );

/**
 * A session-level view used only for the diff record's hash. Frames are merged
 * in deterministic key order so the hash is stable across reads.
 */
const mergedContentOf = (frames: ReadonlyMap<string, FrameSnapshot>): StorageSnapshotContent => {
  const ordered = [...frames.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const merged: StorageSnapshotContent = {
    cookies: { status: "not_collected", reason: "not_applicable" },
    ...unreadablePageStorage("not_applicable"),
  };
  const localStorage: { key: string; value: string }[] = [];
  const sessionStorage: { key: string; value: string }[] = [];
  let cookies: StorageSnapshotContent["cookies"] = merged.cookies;

  for (const [key, snapshot] of ordered) {
    if (snapshot.content.localStorage.status === "collected") {
      for (const entry of snapshot.content.localStorage.value) {
        localStorage.push({ key: `${key}::${entry.key}`, value: entry.value });
      }
    }
    if (snapshot.content.sessionStorage.status === "collected") {
      for (const entry of snapshot.content.sessionStorage.value) {
        sessionStorage.push({ key: `${key}::${entry.key}`, value: entry.value });
      }
    }
    if (snapshot.content.cookies.status === "collected") {
      cookies = snapshot.content.cookies;
    }
  }

  return {
    ...merged,
    cookies,
    localStorage: { status: "collected", value: localStorage },
    sessionStorage: { status: "collected", value: sessionStorage },
  };
};

/** Bind the requester to `chrome.tabs.sendMessage` for a real browser. */
export const chromePageStorageRequester =
  (tabs: {
    sendMessage(
      tabId: number,
      message: unknown,
      options: { frameId: number },
    ): Promise<unknown>;
  }): PageStorageRequester =>
  async (target, sessionId) => {
    const raw = await tabs.sendMessage(
      target.tabId,
      {
        protocolVersion: PROTOCOL_VERSION,
        type: "content/collectPageStorage",
        sessionId,
      },
      { frameId: target.frameId },
    );
    const parsed = raw as { ok?: boolean; value?: CollectPageStorageResponse } | null;
    return parsed?.ok === true && parsed.value !== undefined ? parsed.value : null;
  };
