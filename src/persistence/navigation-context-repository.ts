import {
  SESSION_INDEX,
  STORES,
  getAllRecords,
  getRecord,
  runAtomicWrite,
} from "./database";
import { SCHEMA_VERSION } from "../schemas/common";
import {
  documentContextKey,
  documentContextRecordSchema,
  sessionTabKey,
  sessionTabRecordSchema,
  type DerivedTabEvidence,
  type DocumentContextRecord,
  type SessionTabRecord,
} from "../schemas/navigation";
import type {
  CaptureEpochId,
  ExtDocumentId,
  ExtFrameId,
  ExtTabId,
  SessionId,
} from "../shared/ids";

export interface RegisterTabInput {
  sessionId: SessionId;
  captureEpochId: CaptureEpochId;
  tabId: ExtTabId;
  registeredAt: number;
}

export interface RegisterDerivedTabInput extends RegisterTabInput {
  evidence: DerivedTabEvidence;
}

export interface UpsertDocumentContextInput {
  sessionId: SessionId;
  captureEpochId: CaptureEpochId;
  tabId: ExtTabId;
  frameId: ExtFrameId;
  documentId: ExtDocumentId;
  parentDocumentId?: ExtDocumentId;
  url: string;
  title?: string;
  committedAt: number;
}

/** Durable membership/document mapping used after MV3 worker restarts. */
export class NavigationContextRepository {
  constructor(private readonly db: IDBDatabase) {}

  async registerRootTab(input: RegisterTabInput): Promise<SessionTabRecord> {
    return this.registerTab({ ...input, kind: "root" });
  }

  async registerDerivedTab(input: RegisterDerivedTabInput): Promise<SessionTabRecord> {
    const existing = await this.getTab(input.sessionId, input.tabId);
    if (existing !== null) {
      return existing;
    }
    return this.registerTab({ ...input, kind: "derived", evidence: input.evidence });
  }

  async getTab(sessionId: SessionId, tabId: ExtTabId): Promise<SessionTabRecord | null> {
    const txn = this.db.transaction([STORES.tabs], "readonly");
    const raw = await getRecord(txn.objectStore(STORES.tabs), sessionTabKey(sessionId, tabId));
    return raw === undefined ? null : sessionTabRecordSchema.parse(raw);
  }

  async listTabsBySession(sessionId: SessionId): Promise<SessionTabRecord[]> {
    const txn = this.db.transaction([STORES.tabs], "readonly");
    const raws = await getAllRecords(
      txn.objectStore(STORES.tabs).index(SESSION_INDEX),
      sessionId,
    );
    return raws.map((raw) => sessionTabRecordSchema.parse(raw));
  }

  async upsertDocument(input: UpsertDocumentContextInput): Promise<DocumentContextRecord> {
    const base = {
      schemaVersion: SCHEMA_VERSION,
      documentKey: documentContextKey(
        input.sessionId,
        input.tabId,
        input.frameId,
        input.documentId,
      ),
      sessionId: input.sessionId,
      captureEpochId: input.captureEpochId,
      tabId: input.tabId,
      frameId: input.frameId,
      documentId: input.documentId,
      url: input.url,
      committedAt: input.committedAt,
    };
    const record = documentContextRecordSchema.parse({
      ...base,
      ...(input.parentDocumentId === undefined
        ? {}
        : { parentDocumentId: input.parentDocumentId }),
      ...(input.title === undefined ? {} : { title: input.title }),
    });
    await runAtomicWrite(this.db, [STORES.documents], (txn) => {
      txn.objectStore(STORES.documents).put(record);
      return Promise.resolve();
    });
    return record;
  }

  /**
   * Every document context recorded for the session, newest commit first.
   * The storage collector uses this to enumerate the frames it must ask for
   * their own page storage — the worker cannot read another frame's storage,
   * and it must never merge areas across frames.
   */
  async listDocumentsBySession(sessionId: SessionId): Promise<DocumentContextRecord[]> {
    const txn = this.db.transaction([STORES.documents], "readonly");
    const raws = await getAllRecords(
      txn.objectStore(STORES.documents).index(SESSION_INDEX),
      sessionId,
    );
    return raws
      .map((raw) => documentContextRecordSchema.parse(raw))
      .sort((left, right) => right.committedAt - left.committedAt);
  }

  async getCurrentDocument(
    sessionId: SessionId,
    tabId: ExtTabId,
    frameId: ExtFrameId,
  ): Promise<DocumentContextRecord | null> {
    const txn = this.db.transaction([STORES.documents], "readonly");
    const raws = await getAllRecords(
      txn.objectStore(STORES.documents).index(SESSION_INDEX),
      sessionId,
    );
    const matches = raws
      .map((raw) => documentContextRecordSchema.parse(raw))
      .filter((record) => record.tabId === tabId && record.frameId === frameId)
      .sort((left, right) => right.committedAt - left.committedAt);
    return matches[0] ?? null;
  }

  private async registerTab(
    input:
      | (RegisterTabInput & { kind: "root" })
      | (RegisterDerivedTabInput & { kind: "derived" }),
  ): Promise<SessionTabRecord> {
    const base = {
      schemaVersion: SCHEMA_VERSION,
      tabKey: sessionTabKey(input.sessionId, input.tabId),
      sessionId: input.sessionId,
      captureEpochId: input.captureEpochId,
      tabId: input.tabId,
      registeredAt: input.registeredAt,
    };
    const record = sessionTabRecordSchema.parse(
      input.kind === "root"
        ? { ...base, kind: "root" }
        : { ...base, kind: "derived", evidence: input.evidence },
    );
    await runAtomicWrite(this.db, [STORES.tabs], (txn) => {
      txn.objectStore(STORES.tabs).put(record);
      return Promise.resolve();
    });
    return record;
  }
}
