import {
  SESSION_INDEX,
  STORES,
  getAllRecords,
  getRecord,
  requestToPromise,
  runAtomicWrite,
  type StoreName,
} from "./database";
import {
  sessionControlRecordSchema,
  sessionRecordSchema,
  type SessionConfig,
  type SessionControlRecord,
  type SessionRecord,
} from "../schemas/session";
import { SCHEMA_VERSION } from "../schemas/common";
import {
  newCaptureEpochId,
  newSessionId,
  type ExtTabId,
  type SessionId,
} from "../shared/ids";
import {
  sessionTabKey,
  sessionTabRecordSchema,
} from "../schemas/navigation";
import {
  transition,
  type SessionLifecycleEvent,
  type TransitionResult,
} from "../core/session-state-machine";
import { businessError, type BusinessError } from "../shared/errors";

/**
 * Session repository: the only writer of `sessions` + `sessionControl`
 * lifecycle fields outside the fact committer. Every transition is persisted
 * in one short transaction and is idempotent (state machine contract).
 */

export interface CreateSessionInput {
  originUrl: string;
  originTitle?: string;
  rootTabId: ExtTabId;
  startMode: "no_reload" | "reload";
  config: SessionConfig;
  now: number;
}

export class SessionRepository {
  constructor(private readonly db: IDBDatabase) {}

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const sessionId = newSessionId();
    const captureEpochId = newCaptureEpochId();

    const sessionBase = {
      schemaVersion: SCHEMA_VERSION,
      sessionId,
      lifecycle: "starting",
      captureQuality: "complete",
      startMode: input.startMode,
      originUrl: input.originUrl,
      rootTabId: input.rootTabId,
      startedAt: input.now,
      config: input.config,
      captureEpochIds: [captureEpochId],
    };
    const session: SessionRecord = sessionRecordSchema.parse(
      input.originTitle === undefined
        ? sessionBase
        : { ...sessionBase, originTitle: input.originTitle },
    );

    const control: SessionControlRecord = sessionControlRecordSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      sessionId,
      captureEpochId,
      lifecycle: "starting",
      cleanStop: false,
      lastCommittedSeqBySource: {},
      openStepIds: [],
      counters: { totalLogicalBytes: 0, responseBodyLogicalBytes: 0, factCount: 0 },
    });

    const rootTab = sessionTabRecordSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      tabKey: sessionTabKey(sessionId, input.rootTabId),
      sessionId,
      captureEpochId,
      tabId: input.rootTabId,
      kind: "root",
      registeredAt: input.now,
    });

    await runAtomicWrite(this.db, [STORES.sessions, STORES.sessionControl, STORES.tabs], async (txn) => {
      txn.objectStore(STORES.sessions).put(session);
      txn.objectStore(STORES.sessionControl).put(control);
      txn.objectStore(STORES.tabs).put(rootTab);
      return Promise.resolve();
    });
    return session;
  }

  async getSession(sessionId: SessionId): Promise<SessionRecord | null> {
    const raw = await this.getRaw(STORES.sessions, sessionId);
    return raw === undefined ? null : sessionRecordSchema.parse(raw);
  }

  async getControl(sessionId: SessionId): Promise<SessionControlRecord | null> {
    const raw = await this.getRaw(STORES.sessionControl, sessionId);
    return raw === undefined ? null : sessionControlRecordSchema.parse(raw);
  }

  async listSessions(): Promise<SessionRecord[]> {
    const txn = this.db.transaction([STORES.sessions], "readonly");
    const raws = await getAllRecords(txn.objectStore(STORES.sessions));
    return raws.map((raw) => sessionRecordSchema.parse(raw));
  }

  async listSessionsForTab(tabId: ExtTabId): Promise<SessionRecord[]> {
    const [sessions, registeredTabs] = await Promise.all([
      this.listSessions(),
      (async () => {
        const txn = this.db.transaction([STORES.tabs], "readonly");
        const raws = await getAllRecords(txn.objectStore(STORES.tabs));
        return raws.map((raw) => sessionTabRecordSchema.parse(raw));
      })(),
    ]);
    const registeredSessionIds = new Set(
      registeredTabs.filter((tab) => tab.tabId === tabId).map((tab) => tab.sessionId),
    );
    return sessions.filter(
      (session) => session.rootTabId === tabId || registeredSessionIds.has(session.sessionId),
    );
  }

  async listControls(): Promise<SessionControlRecord[]> {
    const txn = this.db.transaction([STORES.sessionControl], "readonly");
    const raws = await getAllRecords(txn.objectStore(STORES.sessionControl));
    return raws.map((raw) => sessionControlRecordSchema.parse(raw));
  }

  /**
   * Apply a lifecycle event atomically to session + control.
   * Idempotent: `unchanged` resolves successfully without a write.
   */
  async applyLifecycleEvent(
    sessionId: SessionId,
    event: SessionLifecycleEvent,
    options: { now: number; cleanStop?: boolean },
  ): Promise<TransitionResult> {
    return runAtomicWrite(
      this.db,
      [STORES.sessions, STORES.sessionControl],
      async (txn) => {
        const sessionsStore = txn.objectStore(STORES.sessions);
        const controlStore = txn.objectStore(STORES.sessionControl);
        const sessionRaw = await getRecord(sessionsStore, sessionId);
        const controlRaw = await getRecord(controlStore, sessionId);
        if (sessionRaw === undefined || controlRaw === undefined) {
          throw new SessionRepositoryError(
            businessError("SESSION_NOT_FOUND", `session ${sessionId} not found`),
          );
        }
        const session = sessionRecordSchema.parse(sessionRaw);
        const control = sessionControlRecordSchema.parse(controlRaw);

        const result = transition(session.lifecycle, event);
        if (result.outcome === "invalid") {
          throw new SessionRepositoryError(
            businessError(
              "SESSION_INVALID_TRANSITION",
              `event ${event} invalid from ${session.lifecycle}`,
              { sessionId, event, state: session.lifecycle },
            ),
          );
        }
        if (result.outcome === "unchanged") {
          return result;
        }

        const next = result.next;
        const updatedSession: SessionRecord = {
          ...session,
          lifecycle: next,
          ...(next === "stopping"
            ? { stopRequestedAt: session.stopRequestedAt ?? options.now }
            : {}),
          ...(next === "completed" ? { stoppedAt: options.now } : {}),
        };
        const updatedControl: SessionControlRecord = {
          ...control,
          lifecycle: next,
          cleanStop: options.cleanStop ?? control.cleanStop,
        };
        sessionsStore.put(sessionRecordSchema.parse(updatedSession));
        controlStore.put(sessionControlRecordSchema.parse(updatedControl));
        return result;
      },
    );
  }

  /**
   * Physically delete a session and ALL its facts. Only legal from
   * `completed` (design 16: deletion is the single physical cleanup entry).
   */
  async deleteSession(sessionId: SessionId, now: number): Promise<void> {
    await this.applyLifecycleEvent(sessionId, "delete_requested", { now });
    const factStores: StoreName[] = [
      STORES.inbox,
      STORES.steps,
      STORES.domRecords,
      STORES.navigations,
      STORES.requests,
      STORES.inFlightRequests,
      STORES.responseBodies,
      STORES.networkStreamMessages,
      STORES.identifierMappings,
      STORES.storageSnapshots,
      STORES.storageDiffs,
      STORES.captureGaps,
      STORES.tabs,
      STORES.documents,
      STORES.exportSnapshots,
      STORES.exportJobs,
    ];
    await runAtomicWrite(
      this.db,
      [...factStores, STORES.sessions, STORES.sessionControl],
      async (txn) => {
        for (const storeName of factStores) {
          const store = txn.objectStore(storeName);
          const index = store.index(SESSION_INDEX);
          const keys = await requestToPromise(index.getAllKeys(sessionId));
          for (const key of keys) {
            store.delete(key);
          }
        }
        txn.objectStore(STORES.sessions).delete(sessionId);
        txn.objectStore(STORES.sessionControl).delete(sessionId);
      },
    );
  }

  private async getRaw(storeName: StoreName, key: string): Promise<unknown> {
    const txn = this.db.transaction([storeName], "readonly");
    return getRecord(txn.objectStore(storeName), key);
  }
}

export class SessionRepositoryError extends Error {
  constructor(readonly businessError: BusinessError) {
    super(businessError.message);
    this.name = "SessionRepositoryError";
  }
}
