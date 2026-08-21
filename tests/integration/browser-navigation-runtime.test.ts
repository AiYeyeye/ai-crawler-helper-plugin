import { describe, expect, it, vi } from "vitest";
import { BrowserNavigationProcessor } from "../../src/background/browser-navigation-processor";
import { ObservationProcessor } from "../../src/background/observation-processor";
import { NavigationContextRepository } from "../../src/persistence/navigation-context-repository";
import { StepRepository } from "../../src/persistence/step-repository";
import { STORES, getAllRecords } from "../../src/persistence/database";
import { navigationRecordSchema } from "../../src/schemas/navigation";
import { contentObservationEnvelopeSchema } from "../../src/schemas/content-observation";
import { SCHEMA_VERSION } from "../../src/schemas/common";
import {
  eventIdSchema,
  extDocumentIdSchema,
  extFrameIdSchema,
  extTabIdSchema,
  navigationRecordIdSchema,
  stepIdSchema,
  type ExtTabId,
} from "../../src/shared/ids";
import { resolveContentSessionContext } from "../../src/background/content-session-context";
import { T0, createHarness, createRecordingSession } from "../helpers/fixtures";

const domBefore = {
  target: {
    kind: "node" as const,
    node: { nodeType: "element" as const, tagName: "a" },
  },
  locators: {
    id: "open",
    cssSelector: "#open",
    xpath: "//*[@id='open']",
    dataAttributes: {},
  },
  parentChain: [],
  shadowHostChain: [],
  iframePath: [],
  capturedAt: T0,
};

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
};

const createNavigationQueueHarness = async (
  suffix: string,
  options: {
    resolveTitle?: (tabId: ExtTabId) => Promise<string | undefined>;
    drainTimeoutMs?: number;
  } = {},
) => {
  const harness = await createHarness({ now: () => T0 + 100 });
  const session = await createRecordingSession(harness);
  const captureEpochId = session.captureEpochIds.at(-1);
  if (captureEpochId === undefined) {
    throw new Error("navigation queue fixture has no capture epoch");
  }
  const contexts = new NavigationContextRepository(harness.db);
  await contexts.upsertDocument({
    sessionId: session.sessionId,
    captureEpochId,
    tabId: session.rootTabId,
    frameId: extFrameIdSchema.parse(0),
    documentId: extDocumentIdSchema.parse(`doc-queue-${suffix}`),
    url: `https://example.com/${suffix}/before`,
    committedAt: T0,
  });
  let stepNo = 0;
  let navigationNo = 0;
  const processor = new ObservationProcessor({
    db: harness.db,
    ingestor: harness.ingestor,
    sessionRepository: harness.sessions,
    stepRepository: new StepRepository(harness.db),
    orchestratorOptions: {
      now: () => T0 + 100,
      schedule: () => () => undefined,
      newStepId: () => stepIdSchema.parse(`stp_queue_${suffix}_${String(stepNo++)}`),
    },
    navigationCoordinatorOptions: {
      newNavigationRecordId: () =>
        navigationRecordIdSchema.parse(`nav_queue_${suffix}_${String(navigationNo++)}`),
      newSystemStepId: () => stepIdSchema.parse(`stp_queue_${suffix}_${String(stepNo++)}`),
    },
  });
  const runtime = new BrowserNavigationProcessor({
    sessions: harness.sessions,
    contexts,
    getObservationProcessor: () => processor,
    ...(options.resolveTitle === undefined ? {} : { resolveTitle: options.resolveTitle }),
    ...(options.drainTimeoutMs === undefined
      ? {}
      : { drainTimeoutMs: options.drainTimeoutMs }),
  });
  return { captureEpochId, contexts, harness, processor, runtime, session };
};

describe("browser navigation runtime", () => {
  it("persists a user navigation, registers a derived tab, and ignores unrelated tabs", async () => {
    let harness = await createHarness({ now: () => T0 + 100 });
    const session = await createRecordingSession(harness);
    const captureEpochId = session.captureEpochIds.at(-1);
    if (captureEpochId === undefined) {
      throw new Error("fixture has no capture epoch");
    }
    const contexts = new NavigationContextRepository(harness.db);
    const rootDocumentId = extDocumentIdSchema.parse("doc-root");
    await contexts.upsertDocument({
      sessionId: session.sessionId,
      captureEpochId,
      tabId: session.rootTabId,
      frameId: extFrameIdSchema.parse(0),
      documentId: rootDocumentId,
      url: "https://example.com/start",
      committedAt: T0,
    });

    let stepNo = 0;
    let navigationNo = 0;
    let eventNo = 0;
    const processor = new ObservationProcessor({
      db: harness.db,
      ingestor: harness.ingestor,
      sessionRepository: harness.sessions,
      stepRepository: new StepRepository(harness.db),
      newEventId: () => eventIdSchema.parse(`evt_navigation_runtime_${String(eventNo++)}`),
      orchestratorOptions: {
        now: () => T0 + 100,
        schedule: () => () => undefined,
        newStepId: () => stepIdSchema.parse(`stp_navigation_runtime_${String(stepNo++)}`),
      },
      navigationCoordinatorOptions: {
        newNavigationRecordId: () =>
          navigationRecordIdSchema.parse(`nav_navigation_runtime_${String(navigationNo++)}`),
        newSystemStepId: () =>
          stepIdSchema.parse(`stp_navigation_runtime_${String(stepNo++)}`),
      },
    });
    const attachedDerivedTabs: number[] = [];
    const runtime = new BrowserNavigationProcessor({
      sessions: harness.sessions,
      contexts,
      getObservationProcessor: () => processor,
      onDerivedTabRegistered: (_sessionId, tabId) => {
        attachedDerivedTabs.push(tabId);
        return Promise.resolve();
      },
    });
    const sourceContext = {
      sessionId: session.sessionId,
      captureEpochId,
      scope: {
        tabId: session.rootTabId,
        frameId: extFrameIdSchema.parse(0),
        documentId: rootDocumentId,
      },
    };
    await processor.process(
      contentObservationEnvelopeSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        eventId: eventIdSchema.parse("evt_navigation_source_action"),
        sourceSeq: 1,
        sessionId: session.sessionId,
        captureEpochId,
        scope: sourceContext.scope,
        sourceTimestamp: T0 + 1,
        payload: {
          kind: "action_started",
          observation: {
            action: {
              type: "click",
              occurredAt: T0 + 1,
              modifiers: { ctrl: false, alt: false, shift: false, meta: false },
            },
            domBefore,
            candidate: false,
          },
        },
      }),
      sourceContext,
    );

    await runtime.handleBeforeNavigate({
      tabId: 1,
      frameId: 0,
      url: "https://example.com/next",
      timeStamp: T0 + 2,
    });
    const committed = await runtime.handleCommitted({
      tabId: 1,
      frameId: 0,
      url: "https://example.com/next",
      documentId: "doc-next",
      transitionType: "link",
      transitionQualifiers: [],
      timeStamp: T0 + 3,
      title: "Next",
    });
    expect(committed?.attribution.kind).toBe("existing_user_step");

    const stepsAfterNavigation = await new StepRepository(harness.db).listStepsBySession(
      session.sessionId,
    );
    expect(stepsAfterNavigation).toEqual([
      expect.objectContaining({
        kind: "user_action",
        phase: "sealed",
        closeReason: "document_replaced",
        domAfter: { captured: false, reason: "document_replaced" },
      }),
    ]);
    const navigationTxn = harness.db.transaction([STORES.navigations], "readonly");
    const navigations = (await getAllRecords(navigationTxn.objectStore(STORES.navigations))).map(
      (raw) => navigationRecordSchema.parse(raw),
    );
    expect(navigations).toEqual([
      expect.objectContaining({
        navigationType: "link",
        beforeDocumentId: "doc-root",
        afterDocumentId: "doc-next",
        beforeUrl: "https://example.com/start",
        afterUrl: "https://example.com/next",
      }),
    ]);

    const nextContext = {
      ...sourceContext,
      scope: { ...sourceContext.scope, documentId: extDocumentIdSchema.parse("doc-next") },
    };
    await processor.process(
      contentObservationEnvelopeSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        eventId: eventIdSchema.parse("evt_derived_source_action"),
        sourceSeq: 2,
        sessionId: session.sessionId,
        captureEpochId,
        scope: nextContext.scope,
        sourceTimestamp: T0 + 4,
        payload: {
          kind: "action_started",
          observation: {
            action: {
              type: "click",
              occurredAt: T0 + 4,
              modifiers: { ctrl: false, alt: false, shift: false, meta: false },
            },
            domBefore,
            candidate: false,
          },
        },
      }),
      nextContext,
    );
    await expect(
      runtime.handleCreatedNavigationTarget({
        tabId: 2,
        sourceTabId: 1,
        sourceFrameId: 0,
        url: "https://example.com/derived",
        timeStamp: T0 + 5,
      }),
    ).resolves.toBe(true);
    expect(attachedDerivedTabs).toEqual([2]);
    const derivedDecision = await runtime.handleCommitted({
      tabId: 2,
      frameId: 0,
      url: "https://example.com/derived",
      documentId: "doc-derived",
      transitionType: "link",
      transitionQualifiers: [],
      timeStamp: T0 + 6,
    });
    expect(derivedDecision?.attribution.kind).toBe("new_system_step");
    const stepsAfterDerived = await new StepRepository(harness.db).listStepsBySession(
      session.sessionId,
    );
    expect(stepsAfterDerived.at(-1)).toMatchObject({
      kind: "system_navigation",
      scope: { tabId: 2, frameId: 0, documentId: "doc-derived" },
      contextLink: {
        state: "verified",
        link: {
          evidenceType: "created_navigation_target",
          sourceStepId: stepsAfterDerived[1]?.stepId,
        },
      },
    });
    await expect(
      resolveContentSessionContext(harness.sessions, {
        tabId: 2,
        frameId: 0,
        documentId: "doc-derived",
      }),
    ).resolves.toMatchObject({ active: true, sessionId: session.sessionId });

    await expect(
      runtime.handleCommitted({
        tabId: 99,
        frameId: 0,
        url: "https://unrelated.example/",
        documentId: "doc-unrelated",
        transitionType: "typed",
        transitionQualifiers: [],
        timeStamp: T0 + 7,
      }),
    ).resolves.toBeNull();
    await expect(
      resolveContentSessionContext(harness.sessions, {
        tabId: 99,
        frameId: 0,
        documentId: "doc-unrelated",
      }),
    ).resolves.toEqual({ active: false });

    const sourceStepId = stepsAfterDerived[1]?.stepId;
    const targetStepId = stepsAfterDerived.at(-1)?.stepId;
    if (sourceStepId === undefined || targetStepId === undefined) {
      throw new Error("fixture did not create source and target Steps");
    }
    harness = await harness.restart();
    await expect(
      new StepRepository(harness.db).getOutgoingContextLinks(sourceStepId),
    ).resolves.toEqual([
      expect.objectContaining({
        sourceStepId,
        targetStepId,
        evidenceType: "created_navigation_target",
        confidence: "verified",
      }),
    ]);
  });

  it("records same-URL reload by new document identity", async () => {
    const harness = await createHarness({ now: () => T0 + 100 });
    const session = await createRecordingSession(harness);
    const captureEpochId = session.captureEpochIds.at(-1);
    if (captureEpochId === undefined) {
      throw new Error("fixture has no capture epoch");
    }
    const contexts = new NavigationContextRepository(harness.db);
    await contexts.upsertDocument({
      sessionId: session.sessionId,
      captureEpochId,
      tabId: session.rootTabId,
      frameId: extFrameIdSchema.parse(0),
      documentId: extDocumentIdSchema.parse("doc-before-reload"),
      url: "https://example.com/same",
      committedAt: T0,
    });
    let stepNo = 0;
    const processor = new ObservationProcessor({
      db: harness.db,
      ingestor: harness.ingestor,
      sessionRepository: harness.sessions,
      stepRepository: new StepRepository(harness.db),
      orchestratorOptions: {
        schedule: () => () => undefined,
        newStepId: () => stepIdSchema.parse(`stp_reload_${String(stepNo++)}`),
      },
      navigationCoordinatorOptions: {
        newNavigationRecordId: () => navigationRecordIdSchema.parse("nav_same_url_reload"),
        newSystemStepId: () => stepIdSchema.parse(`stp_reload_${String(stepNo++)}`),
      },
    });
    const runtime = new BrowserNavigationProcessor({
      sessions: harness.sessions,
      contexts,
      getObservationProcessor: () => processor,
    });
    await runtime.handleBeforeNavigate({
      tabId: 1,
      frameId: 0,
      url: "https://example.com/same",
      timeStamp: T0 + 1,
    });
    const decision = await runtime.handleCommitted({
      tabId: 1,
      frameId: 0,
      url: "https://example.com/same",
      documentId: "doc-after-reload",
      transitionType: "reload",
      transitionQualifiers: [],
      timeStamp: T0 + 2,
    });
    expect(decision?.navigation).toMatchObject({
      navigationType: "reload",
      beforeDocumentId: "doc-before-reload",
      afterDocumentId: "doc-after-reload",
    });
    expect((await contexts.getCurrentDocument(
      session.sessionId,
      extTabIdSchema.parse(1),
      extFrameIdSchema.parse(0),
    ))?.documentId).toBe("doc-after-reload");
  });

  it("does not let onCommitted overtake a slow onBeforeNavigate for one frame", async () => {
    const harness = await createHarness({ now: () => T0 + 100 });
    const session = await createRecordingSession(harness);
    const captureEpochId = session.captureEpochIds.at(-1);
    if (captureEpochId === undefined) {
      throw new Error("fixture has no capture epoch");
    }
    const contexts = new NavigationContextRepository(harness.db);
    await contexts.upsertDocument({
      sessionId: session.sessionId,
      captureEpochId,
      tabId: session.rootTabId,
      frameId: extFrameIdSchema.parse(0),
      documentId: extDocumentIdSchema.parse("doc-ordered-before"),
      url: "https://example.com/before",
      committedAt: T0,
    });
    let stepNo = 0;
    const processor = new ObservationProcessor({
      db: harness.db,
      ingestor: harness.ingestor,
      sessionRepository: harness.sessions,
      stepRepository: new StepRepository(harness.db),
      orchestratorOptions: {
        schedule: () => () => undefined,
        newStepId: () => stepIdSchema.parse(`stp_ordered_nav_${String(stepNo++)}`),
      },
      navigationCoordinatorOptions: {
        newNavigationRecordId: () => navigationRecordIdSchema.parse("nav_ordered_callbacks"),
        newSystemStepId: () => stepIdSchema.parse(`stp_ordered_nav_${String(stepNo++)}`),
      },
    });
    const beforeEntered = deferred();
    const releaseBefore = deferred();
    const originalActiveUserStepId = processor.activeUserStepId.bind(processor);
    vi.spyOn(processor, "activeUserStepId").mockImplementation(async (context) => {
      beforeEntered.resolve(undefined);
      await releaseBefore.promise;
      return originalActiveUserStepId(context);
    });
    const recordNavigation = vi.spyOn(processor, "recordNavigation");
    const runtime = new BrowserNavigationProcessor({
      sessions: harness.sessions,
      contexts,
      getObservationProcessor: () => processor,
    });

    const beforePromise = runtime.handleBeforeNavigate({
      tabId: 1,
      frameId: 0,
      url: "https://example.com/after",
      timeStamp: T0 + 1,
    });
    await beforeEntered.promise;
    const committedPromise = runtime.handleCommitted({
      tabId: 1,
      frameId: 0,
      url: "https://example.com/after",
      documentId: "doc-ordered-after",
      transitionType: "link",
      transitionQualifiers: [],
      timeStamp: T0 + 2,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(recordNavigation).not.toHaveBeenCalled();

    releaseBefore.resolve(undefined);
    await Promise.all([beforePromise, committedPromise]);
    expect(recordNavigation).toHaveBeenCalledTimes(1);
  });

  it("normalizes fractional webNavigation timestamps into integer epoch facts", async () => {
    const harness = await createHarness({ now: () => T0 + 100 });
    const session = await createRecordingSession(harness);
    const captureEpochId = session.captureEpochIds.at(-1);
    if (captureEpochId === undefined) {
      throw new Error("fixture has no capture epoch");
    }
    const contexts = new NavigationContextRepository(harness.db);
    await contexts.upsertDocument({
      sessionId: session.sessionId,
      captureEpochId,
      tabId: session.rootTabId,
      frameId: extFrameIdSchema.parse(0),
      documentId: extDocumentIdSchema.parse("doc-float-root"),
      url: "https://example.com/start",
      committedAt: T0,
    });
    let stepNo = 0;
    const processor = new ObservationProcessor({
      db: harness.db,
      ingestor: harness.ingestor,
      sessionRepository: harness.sessions,
      stepRepository: new StepRepository(harness.db),
      orchestratorOptions: {
        schedule: () => () => undefined,
        newStepId: () => stepIdSchema.parse(`stp_float_${String(stepNo++)}`),
      },
      navigationCoordinatorOptions: {
        newNavigationRecordId: () => navigationRecordIdSchema.parse("nav_float_ts"),
        newSystemStepId: () => stepIdSchema.parse(`stp_float_${String(stepNo++)}`),
      },
    });
    const runtime = new BrowserNavigationProcessor({
      sessions: harness.sessions,
      contexts,
      getObservationProcessor: () => processor,
    });

    await runtime.handleBeforeNavigate({
      tabId: 1,
      frameId: 0,
      url: "https://example.com/hop-a",
      timeStamp: T0 + 1.25,
    });
    await runtime.handleBeforeNavigate({
      tabId: 1,
      frameId: 0,
      url: "https://example.com/hop-b",
      timeStamp: T0 + 2.75,
    });
    const decision = await runtime.handleCommitted({
      tabId: 1,
      frameId: 0,
      url: "https://example.com/hop-b",
      documentId: "doc-float-next",
      transitionType: "link",
      transitionQualifiers: [],
      timeStamp: T0 + 3.5,
    });
    expect(decision?.navigation).toMatchObject({
      committedAt: T0 + 4,
      redirectChain: [
        {
          fromUrl: "https://example.com/hop-a",
          toUrl: "https://example.com/hop-b",
          occurredAt: T0 + 3,
        },
      ],
    });
    expect(
      (await contexts.getCurrentDocument(
        session.sessionId,
        extTabIdSchema.parse(1),
        extFrameIdSchema.parse(0),
      ))?.committedAt,
    ).toBe(T0 + 4);

    await expect(
      runtime.handleCreatedNavigationTarget({
        tabId: 2,
        sourceTabId: 1,
        sourceFrameId: 0,
        url: "https://example.com/derived",
        timeStamp: T0 + 5.5,
      }),
    ).resolves.toBe(true);
    expect(
      (await contexts.getTab(session.sessionId, extTabIdSchema.parse(2)))?.registeredAt,
    ).toBe(T0 + 6);
  });

  it("keeps exact History API type and links a parent-triggered iframe navigation", async () => {
    const harness = await createHarness({ now: () => T0 + 100 });
    const session = await createRecordingSession(harness);
    const captureEpochId = session.captureEpochIds.at(-1);
    if (captureEpochId === undefined) {
      throw new Error("fixture has no capture epoch");
    }
    const contexts = new NavigationContextRepository(harness.db);
    const parentDocumentId = extDocumentIdSchema.parse("doc-parent");
    await contexts.upsertDocument({
      sessionId: session.sessionId,
      captureEpochId,
      tabId: session.rootTabId,
      frameId: extFrameIdSchema.parse(0),
      documentId: parentDocumentId,
      url: "https://example.com/parent",
      committedAt: T0,
    });
    let stepNo = 0;
    let navigationNo = 0;
    const processor = new ObservationProcessor({
      db: harness.db,
      ingestor: harness.ingestor,
      sessionRepository: harness.sessions,
      stepRepository: new StepRepository(harness.db),
      orchestratorOptions: {
        now: () => T0 + 100,
        schedule: () => () => undefined,
        newStepId: () => stepIdSchema.parse(`stp_iframe_${String(stepNo++)}`),
      },
      navigationCoordinatorOptions: {
        newNavigationRecordId: () =>
          navigationRecordIdSchema.parse(`nav_iframe_${String(navigationNo++)}`),
        newSystemStepId: () => stepIdSchema.parse(`stp_iframe_${String(stepNo++)}`),
      },
    });
    const parentContext = {
      sessionId: session.sessionId,
      captureEpochId,
      scope: {
        tabId: session.rootTabId,
        frameId: extFrameIdSchema.parse(0),
        documentId: parentDocumentId,
      },
    };
    await processor.process(
      contentObservationEnvelopeSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        eventId: eventIdSchema.parse("evt_parent_action"),
        sourceSeq: 1,
        sessionId: session.sessionId,
        captureEpochId,
        scope: parentContext.scope,
        sourceTimestamp: T0 + 1,
        payload: {
          kind: "action_started",
          observation: {
            action: {
              type: "click",
              occurredAt: T0 + 1,
              modifiers: { ctrl: false, alt: false, shift: false, meta: false },
            },
            domBefore,
            candidate: false,
          },
        },
      }),
      parentContext,
    );
    await processor.process(
      contentObservationEnvelopeSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        eventId: eventIdSchema.parse("evt_history_replace"),
        sourceSeq: 2,
        sessionId: session.sessionId,
        captureEpochId,
        scope: parentContext.scope,
        sourceTimestamp: T0 + 2,
        payload: {
          kind: "navigation_observed",
          navigation: {
            action: "replace",
            beforeUrl: "https://example.com/parent",
            afterUrl: "https://example.com/parent?state=ready",
          },
        },
      }),
      parentContext,
    );

    const runtime = new BrowserNavigationProcessor({
      sessions: harness.sessions,
      contexts,
      getObservationProcessor: () => processor,
    });
    await runtime.handleBeforeNavigate({
      tabId: 1,
      frameId: 5,
      parentFrameId: 0,
      url: "https://frame.example/child",
      timeStamp: T0 + 3,
    });
    const decision = await runtime.handleCommitted({
      tabId: 1,
      frameId: 5,
      parentDocumentId: "doc-parent",
      url: "https://frame.example/child",
      documentId: "doc-child",
      transitionType: "auto_subframe",
      transitionQualifiers: [],
      timeStamp: T0 + 4,
    });
    expect(decision?.attribution.kind).toBe("new_system_step");

    const steps = await new StepRepository(harness.db).listStepsBySession(session.sessionId);
    expect(steps.at(-1)).toMatchObject({
      kind: "system_navigation",
      scope: { tabId: 1, frameId: 5, documentId: "doc-child" },
      contextLink: {
        state: "verified",
        link: {
          evidenceType: "parent_frame_navigation",
          sourceStepId: steps[0]?.stepId,
        },
      },
    });
    const navigationTxn = harness.db.transaction([STORES.navigations], "readonly");
    const navigations = (await getAllRecords(navigationTxn.objectStore(STORES.navigations))).map(
      (raw) => navigationRecordSchema.parse(raw),
    );
    expect(navigations.map((record) => record.navigationType)).toEqual([
      "history_replace",
      "other",
    ]);
  });

  it("queues created-navigation-target work before later events from its source frame", async () => {
    const { processor, runtime } = await createNavigationQueueHarness("created-target-order");
    const createdEntered = deferred();
    const releaseCreated = deferred();
    vi.spyOn(processor, "activeStepId").mockImplementation(async () => {
      createdEntered.resolve(undefined);
      await releaseCreated.promise;
      return null;
    });
    const recordNavigation = vi.spyOn(processor, "recordNavigation");

    const createdPromise = runtime.handleCreatedNavigationTarget({
      tabId: 2,
      sourceTabId: 1,
      sourceFrameId: 0,
      url: "https://example.com/created-target-order/derived",
      timeStamp: T0 + 1,
    });
    await createdEntered.promise;
    const committedPromise = runtime.handleCommitted({
      tabId: 1,
      frameId: 0,
      url: "https://example.com/created-target-order/after",
      documentId: "doc-created-target-order-after",
      transitionType: "link",
      transitionQualifiers: [],
      timeStamp: T0 + 2,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    const callsBeforeRelease = recordNavigation.mock.calls.length;

    releaseCreated.resolve(undefined);
    await Promise.all([createdPromise, committedPromise]);
    expect(callsBeforeRelease).toBe(0);
    expect(recordNavigation).toHaveBeenCalledTimes(1);
  });

  it("queues tab-created work before later events from its opener frame", async () => {
    const { processor, runtime } = await createNavigationQueueHarness("tab-created-order");
    const createdEntered = deferred();
    const releaseCreated = deferred();
    vi.spyOn(processor, "activeStepId").mockImplementation(async () => {
      createdEntered.resolve(undefined);
      await releaseCreated.promise;
      return null;
    });
    const recordNavigation = vi.spyOn(processor, "recordNavigation");

    const createdPromise = runtime.handleTabCreated({
      tabId: 2,
      openerTabId: 1,
      createdAt: T0 + 1,
    });
    await createdEntered.promise;
    const committedPromise = runtime.handleCommitted({
      tabId: 1,
      frameId: 0,
      url: "https://example.com/tab-created-order/after",
      documentId: "doc-tab-created-order-after",
      transitionType: "link",
      transitionQualifiers: [],
      timeStamp: T0 + 2,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    const callsBeforeRelease = recordNavigation.mock.calls.length;

    releaseCreated.resolve(undefined);
    await Promise.all([createdPromise, committedPromise]);
    expect(callsBeforeRelease).toBe(0);
    expect(recordNavigation).toHaveBeenCalledTimes(1);
  });

  it("seals unresolved admissions by session generation before they can write", async () => {
    const { harness, processor, runtime, session } =
      await createNavigationQueueHarness("admission-owner");
    const controlEntered = deferred();
    const releaseControl = deferred();
    const originalGetControl = harness.sessions.getControl.bind(harness.sessions);
    let firstControlLookup = true;
    vi.spyOn(harness.sessions, "getControl").mockImplementation(async (sessionId) => {
      if (firstControlLookup) {
        firstControlLookup = false;
        controlEntered.resolve(undefined);
        await releaseControl.promise;
      }
      return originalGetControl(sessionId);
    });
    const activeUserStepId = vi.spyOn(processor, "activeUserStepId");
    const beforePromise = runtime.handleBeforeNavigate({
      tabId: 1,
      frameId: 0,
      url: "https://example.com/admission-owner/after",
      timeStamp: T0 + 1,
    });
    await controlEntered.promise;

    const sealAndDrain = (
      runtime as unknown as {
        sealAndDrain?: (sessionId: typeof session.sessionId) => Promise<void>;
      }
    ).sealAndDrain;
    if (sealAndDrain === undefined) {
      releaseControl.resolve(undefined);
      await beforePromise;
      expect(sealAndDrain).toBeDefined();
      return;
    }
    let drained = false;
    const drainPromise = sealAndDrain.call(runtime, session.sessionId).then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    const drainedBeforeRelease = drained;
    releaseControl.resolve(undefined);
    await Promise.all([beforePromise, drainPromise]);

    expect(drainedBeforeRelease).toBe(false);
    expect(activeUserStepId).not.toHaveBeenCalled();
  });

  it("propagates an admitted navigation handler failure through sealAndDrain", async () => {
    const { processor, runtime, session } = await createNavigationQueueHarness("drain-failure");
    vi.spyOn(processor, "activeUserStepId").mockRejectedValue(
      new Error("navigation handler failed"),
    );
    await expect(
      runtime.handleBeforeNavigate({
        tabId: 1,
        frameId: 0,
        url: "https://example.com/drain-failure/after",
        timeStamp: T0 + 1,
      }),
    ).rejects.toThrow("navigation handler failed");

    const sealAndDrain = (
      runtime as unknown as {
        sealAndDrain?: (sessionId: typeof session.sessionId) => Promise<void>;
      }
    ).sealAndDrain;
    expect(sealAndDrain).toBeDefined();
    if (sealAndDrain !== undefined) {
      await expect(sealAndDrain.call(runtime, session.sessionId)).rejects.toThrow(
        "navigation handler failed",
      );
    }
  });

  it("makes forgetSession wait for already admitted navigation work", async () => {
    const { processor, runtime, session } = await createNavigationQueueHarness("forget-drain");
    const handlerEntered = deferred();
    const releaseHandler = deferred();
    vi.spyOn(processor, "activeUserStepId").mockImplementation(async () => {
      handlerEntered.resolve(undefined);
      await releaseHandler.promise;
      return null;
    });
    const beforePromise = runtime.handleBeforeNavigate({
      tabId: 1,
      frameId: 0,
      url: "https://example.com/forget-drain/after",
      timeStamp: T0 + 1,
    });
    await handlerEntered.promise;
    let forgotten = false;
    const forgetPromise = Promise.resolve(runtime.forgetSession(session.sessionId)).then(() => {
      forgotten = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    const forgottenBeforeRelease = forgotten;

    releaseHandler.resolve(undefined);
    await Promise.all([beforePromise, forgetPromise]);
    expect(forgottenBeforeRelease).toBe(false);
  });

  it("resolves main-frame titles inside the ordered commit queue", async () => {
    const firstTitleEntered = deferred();
    const releaseFirstTitle = deferred();
    let titleCalls = 0;
    const resolveTitle = vi.fn(async () => {
      titleCalls += 1;
      if (titleCalls === 1) {
        firstTitleEntered.resolve(undefined);
        await releaseFirstTitle.promise;
        return "First title";
      }
      return "Second title";
    });
    const { processor, runtime } = await createNavigationQueueHarness("title-order", {
      resolveTitle,
    });
    const recordNavigation = vi.spyOn(processor, "recordNavigation");
    const firstCommit = runtime.handleCommitted({
      tabId: 1,
      frameId: 0,
      url: "https://example.com/title-order/first",
      documentId: "doc-title-order-first",
      transitionType: "link",
      transitionQualifiers: [],
      timeStamp: T0 + 1,
    });
    const resolverStarted = await Promise.race([
      firstTitleEntered.promise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => { resolve(false); }, 100)),
    ]);
    if (!resolverStarted) {
      await firstCommit;
      expect(resolverStarted).toBe(true);
      return;
    }
    const secondCommit = runtime.handleCommitted({
      tabId: 1,
      frameId: 0,
      url: "https://example.com/title-order/second",
      documentId: "doc-title-order-second",
      transitionType: "link",
      transitionQualifiers: [],
      timeStamp: T0 + 2,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    const titleCallsBeforeRelease = resolveTitle.mock.calls.length;
    const navigationCallsBeforeRelease = recordNavigation.mock.calls.length;

    releaseFirstTitle.resolve(undefined);
    await Promise.all([firstCommit, secondCommit]);
    expect(titleCallsBeforeRelease).toBe(1);
    expect(navigationCallsBeforeRelease).toBe(0);
    expect(recordNavigation.mock.calls.map(([input]) => input.title)).toEqual([
      "First title",
      "Second title",
    ]);
  });

  it("reclaims idle frame generation and ownership state", async () => {
    const { runtime } = await createNavigationQueueHarness("bounded-frame-state");
    for (let frameId = 0; frameId < 100; frameId += 1) {
      runtime.handleNavigationError(1, frameId);
    }
    const state = runtime as unknown as {
      queueTails: Map<string, unknown>;
      frameGenerations: Map<string, unknown>;
      sessionByFrame: Map<string, unknown>;
    };
    expect({
      queueTails: state.queueTails.size,
      frameGenerations: state.frameGenerations.size,
      sessionByFrame: state.sessionByFrame.size,
    }).toEqual({ queueTails: 0, frameGenerations: 0, sessionByFrame: 0 });
  });
});
