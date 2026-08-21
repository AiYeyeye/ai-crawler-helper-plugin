import { IDBFactory } from "fake-indexeddb";
import { openDatabase } from "../../src/persistence/database";
import { SessionRepository } from "../../src/persistence/session-repository";
import { FactIngestor } from "../../src/persistence/fact-ingestor";
import { StoragePressureController } from "../../src/persistence/storage-pressure";
import { InMemoryControlMirror } from "../../src/persistence/control-mirror";
import { CapacityGuard, type StorageEstimateProvider } from "../../src/core/capacity-guard";
import { DEFAULT_CAPACITY_GUARD_CONFIG, type CapacityGuardConfig } from "../../src/core/config";
import { SCHEMA_VERSION } from "../../src/schemas/common";
import type {
  SessionRecord,
  SessionConfig,
  SessionControlRecord,
} from "../../src/schemas/session";
import { sessionControlRecordSchema, sessionRecordSchema } from "../../src/schemas/session";
import {
  captureEpochIdSchema,
  eventIdSchema,
  extDocumentIdSchema,
  extFrameIdSchema,
  extTabIdSchema,
  attachEpochSchema,
  cdpRequestIdSchema,
  sessionIdSchema,
  stepIdSchema,
  type SessionId,
  type StepId,
} from "../../src/shared/ids";
import type { EventEnvelope, FactPayload } from "../../src/schemas/event-envelope";
import {
  sealedUserActionStepSchema,
  type DraftSystemActivityStep,
  type SealedUserActionStep,
} from "../../src/schemas/step";
import type { DomLocators } from "../../src/schemas/dom";
import { buildRequestKey, type RequestRecord } from "../../src/schemas/network";

/** Deterministic fixture clock. */
export const T0 = 1_700_000_000_000;

export const defaultSessionConfig = (
  overrides: Partial<SessionConfig> = {},
): SessionConfig => ({
  responseBodySoftBudgetBytes: 100 * 1024 * 1024,
  responseBodyMaxBytes: 2 * 1024 * 1024,
  hoverDwellThresholdMs: 500,
  networkQuietWindowMs: 800,
  stepMaxWindowMs: 10_000,
  userFilterRules: [],
  extraCookieDomains: [],
  ...overrides,
});

export interface TestHarness {
  db: IDBDatabase;
  sessions: SessionRepository;
  ingestor: FactIngestor;
  pressure: StoragePressureController;
  guard: CapacityGuard;
  mirror: InMemoryControlMirror;
  factory: IDBFactory;
  dbName: string;
  /** Simulate a service-worker restart: reopen DB with fresh instances. */
  restart: () => Promise<TestHarness>;
}

export interface HarnessOptions {
  estimateProvider?: StorageEstimateProvider;
  guardConfig?: CapacityGuardConfig;
  now?: () => number;
}

const plentyOfSpace: StorageEstimateProvider = () =>
  Promise.resolve({ quota: 10 * 1024 * 1024 * 1024, usage: 0 });

let dbCounter = 0;

export const createHarness = async (options: HarnessOptions = {}): Promise<TestHarness> => {
  const factory = new IDBFactory();
  const dbName = `test-db-${String(dbCounter++)}`;
  return attach(factory, dbName, options);
};

const attach = async (
  factory: IDBFactory,
  dbName: string,
  options: HarnessOptions,
): Promise<TestHarness> => {
  const db = await openDatabase(factory, dbName);
  const guard = new CapacityGuard(
    options.estimateProvider ?? plentyOfSpace,
    options.guardConfig ?? DEFAULT_CAPACITY_GUARD_CONFIG,
    options.now ?? (() => T0),
  );
  const mirror = new InMemoryControlMirror();
  const pressure = new StoragePressureController(db, mirror);
  const ingestor = new FactIngestor(db, guard, pressure, options.now ?? (() => T0));
  return {
    db,
    sessions: new SessionRepository(db),
    ingestor,
    pressure,
    guard,
    mirror,
    factory,
    dbName,
    restart: async () => {
      db.close();
      return attach(factory, dbName, options);
    },
  };
};

/** Create a session already in `recording`. */
export const createRecordingSession = async (
  harness: TestHarness,
  configOverrides: Partial<SessionConfig> = {},
): Promise<SessionRecord> => {
  const session = await harness.sessions.createSession({
    originUrl: "https://example.com/",
    rootTabId: extTabIdSchema.parse(1),
    startMode: "no_reload",
    config: defaultSessionConfig(configOverrides),
    now: T0,
  });
  await harness.sessions.applyLifecycleEvent(session.sessionId, "start_completed", { now: T0 });
  const refreshed = await harness.sessions.getSession(session.sessionId);
  if (refreshed === null) {
    throw new Error("session vanished");
  }
  return refreshed;
};

let seqCounter = 0;
let eventCounter = 0;

export const makeEnvelope = (
  sessionId: SessionId,
  payload: FactPayload,
  overrides: Partial<Pick<EventEnvelope, "eventId" | "sourceSeq">> = {},
): EventEnvelope => ({
  schemaVersion: SCHEMA_VERSION,
  eventId: overrides.eventId ?? eventIdSchema.parse(`evt_${String(eventCounter++)}`),
  source: "content_script",
  sourceSeq: overrides.sourceSeq ?? seqCounter++,
  sessionId,
  scope: {
    tabId: extTabIdSchema.parse(1),
    documentId: extDocumentIdSchema.parse("doc-1"),
    frameId: extFrameIdSchema.parse(0),
  },
  sourceTimestamp: T0,
  payload,
});

export const makeDraftSystemActivityStep = (
  session: SessionRecord,
  stepId: StepId,
  ordinal: number,
): DraftSystemActivityStep => {
  const captureEpochId = session.captureEpochIds.at(-1);
  if (captureEpochId === undefined) {
    throw new Error("session has no capture epoch");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    stepId,
    sessionId: session.sessionId,
    captureEpochId,
  scope: {
    tabId: extTabIdSchema.parse(1),
    documentId: extDocumentIdSchema.parse("doc-1"),
    frameId: extFrameIdSchema.parse(0),
  },
  ordinal,
  startedAt: T0,
  excluded: false,
  phase: "draft",
  candidate: false,
  requestKeys: [],
  storageDiffIds: [],
  domRecordIds: [],
  kind: "system_activity",
  type: "system_activity",
  trigger: "background_network",
  backgroundCandidate: true,
  };
};

/** Pure in-memory session record — no IndexedDB, for unit-level fixtures. */
export const makeSessionRecord = (
  overrides: Partial<SessionRecord> = {},
): SessionRecord =>
  sessionRecordSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    sessionId: sessionIdSchema.parse("ses_test_1"),
    lifecycle: "recording",
    captureQuality: "complete",
    startMode: "no_reload",
    originUrl: "https://example.com/",
    rootTabId: extTabIdSchema.parse(1),
    startedAt: T0,
    config: defaultSessionConfig(),
    captureEpochIds: [captureEpochIdSchema.parse("cep_test_1")],
    ...overrides,
  });

export const stepId = (n: number): StepId => stepIdSchema.parse(`stp_test_${String(n)}`);

/** Pure in-memory control record matching `makeSessionRecord`. */
export const makeControlRecord = (
  session: SessionRecord,
  overrides: Partial<SessionControlRecord> = {},
): SessionControlRecord => {
  const captureEpochId = session.captureEpochIds.at(-1);
  if (captureEpochId === undefined) {
    throw new Error("session has no capture epoch");
  }
  return sessionControlRecordSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    sessionId: session.sessionId,
    captureEpochId,
    lifecycle: session.lifecycle,
    cleanStop: false,
    lastCommittedSeqBySource: {},
    openStepIds: [],
    counters: {
      totalLogicalBytes: 4096,
      responseBodyLogicalBytes: 1024,
      factCount: 12,
    },
    ...overrides,
  });
};

/** Minimal locator set; extra identity fields are supplied per test. */
export const makeLocators = (
  overrides: Partial<DomLocators> = {},
): DomLocators => ({
  cssSelector: "#root > button.primary",
  xpath: "/html/body/div/button",
  dataAttributes: {},
  ...overrides,
});

/**
 * A sealed `user_action` step — the only phase the fact summary accepts.
 * Deterministic by construction so byte-equality assertions are meaningful.
 */
export const makeSealedUserActionStep = (
  session: SessionRecord,
  id: StepId,
  ordinal: number,
  overrides: {
    locators?: Partial<DomLocators>;
    requestKeys?: string[];
    storageDiffIds?: string[];
    excluded?: boolean;
    note?: string;
  } = {},
): SealedUserActionStep => {
  const captureEpochId = session.captureEpochIds.at(-1);
  if (captureEpochId === undefined) {
    throw new Error("session has no capture epoch");
  }
  const locators = makeLocators(overrides.locators ?? {});
  const base = {
    schemaVersion: SCHEMA_VERSION,
    stepId: id,
    sessionId: session.sessionId,
    captureEpochId,
    scope: {
      tabId: extTabIdSchema.parse(1),
      documentId: extDocumentIdSchema.parse("doc-1"),
      frameId: extFrameIdSchema.parse(0),
    },
    ordinal,
    startedAt: T0,
    excluded: overrides.excluded ?? false,
    phase: "sealed" as const,
    endedAt: T0 + 1234,
    closeReason: "network_quiet" as const,
    domAfter: {
      captured: true as const,
      mutationSummary: { added: 2, updated: 1, removed: 0 },
      capturedAt: T0 + 1000,
    },
    requestKeys: overrides.requestKeys ?? [],
    storageDiffIds: overrides.storageDiffIds ?? [],
    domRecordIds: [],
    kind: "user_action" as const,
    type: "click" as const,
    action: {
      type: "click" as const,
      occurredAt: T0,
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    },
    domBefore: {
      target: { kind: "node" as const, node: { nodeType: "element" as const, tagName: "button" } },
      locators,
      parentChain: [],
      shadowHostChain: [],
      iframePath: [],
      capturedAt: T0,
    },
  };
  return sealedUserActionStepSchema.parse(
    overrides.note === undefined ? base : { ...base, note: overrides.note },
  );
};

export const makeRequestRecord = (
  session: SessionRecord,
  startedInStepId: StepId,
  requestNo: number,
): RequestRecord => {
  const captureEpochId = session.captureEpochIds.at(-1);
  if (captureEpochId === undefined) {
    throw new Error("session has no capture epoch");
  }
  const keyParts = {
    tabId: extTabIdSchema.parse(1),
    attachEpoch: attachEpochSchema.parse(0),
    requestId: cdpRequestIdSchema.parse(`req-${String(requestNo)}`),
    redirectHop: 0,
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    requestKey: buildRequestKey(keyParts),
    keyParts,
    sessionId: session.sessionId,
    captureEpochId,
    scope: {
      tabId: extTabIdSchema.parse(1),
      documentId: extDocumentIdSchema.parse("doc-1"),
      frameId: extFrameIdSchema.parse(0),
    },
    startedInStepId,
    identifierMapping: { state: "unmapped" },
    method: "GET",
    url: `https://example.com/api/${String(requestNo)}`,
    queryParams: [],
    requestHeaders: [{ name: "accept", value: "application/json" }],
    startedAt: T0,
  };
};
