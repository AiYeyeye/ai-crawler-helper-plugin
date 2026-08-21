import { describe, expect, it, vi } from "vitest";
import {
  DebuggerSessionManager,
  type DebuggerCommandTarget,
  type DebuggerTransport,
} from "../../src/background/debugger-session-manager";
import { SCHEMA_VERSION } from "../../src/schemas/common";
import type { EventEnvelope } from "../../src/schemas/event-envelope";
import { sessionRecordSchema, type SessionRecord } from "../../src/schemas/session";
import {
  attachEpochSchema,
  captureEpochIdSchema,
  cdpSessionIdSchema,
  extTabIdSchema,
  gapIdSchema,
  sessionIdSchema,
} from "../../src/shared/ids";

const T0 = 1_700_000_000_000;

const session = (): SessionRecord =>
  sessionRecordSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    sessionId: sessionIdSchema.parse("ses-debugger"),
    lifecycle: "starting",
    captureQuality: "complete",
    startMode: "no_reload",
    originUrl: "https://example.com/",
    rootTabId: extTabIdSchema.parse(9),
    startedAt: T0,
    config: {
      responseBodySoftBudgetBytes: 100 * 1024 * 1024,
      responseBodyMaxBytes: 2 * 1024 * 1024,
      hoverDwellThresholdMs: 500,
      networkQuietWindowMs: 800,
      stepMaxWindowMs: 10_000,
      userFilterRules: [],
      extraCookieDomains: [],
    },
    captureEpochIds: [captureEpochIdSchema.parse("cep-debugger")],
  });

interface SentCommand {
  target: DebuggerCommandTarget;
  method: string;
  params?: Readonly<Record<string, unknown>>;
}

class FakeDebuggerTransport implements DebuggerTransport {
  readonly attachedTabs: number[] = [];
  readonly detachedTabs: number[] = [];
  readonly commands: SentCommand[] = [];
  rejectDurableProbe = true;
  rejectTargetDiscovery = false;
  rejectChildSessionId: string | null = null;
  rejectRootNetworkEnable = false;
  readonly rejectAttachTabs = new Set<number>();

  attach(tabId: number): Promise<void> {
    this.attachedTabs.push(tabId);
    if (this.rejectAttachTabs.has(tabId)) {
      return Promise.reject(new Error("debugger attach failed"));
    }
    return Promise.resolve();
  }

  detach(tabId: number): Promise<void> {
    this.detachedTabs.push(tabId);
    return Promise.resolve();
  }

  sendCommand(
    target: DebuggerCommandTarget,
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    this.commands.push({ target, method, ...(params === undefined ? {} : { params }) });
    if (method === "Network.enable" && target.sessionId === this.rejectChildSessionId) {
      return Promise.reject(new Error("child Network.enable failed"));
    }
    if (method === "Network.enable" && target.sessionId === undefined && this.rejectRootNetworkEnable) {
      return Promise.reject(new Error("root Network.enable failed"));
    }
    if (
      this.rejectDurableProbe &&
      method === "Network.enable" &&
      params?.enableDurableMessages === true
    ) {
      this.rejectDurableProbe = false;
      return Promise.reject(new Error("Invalid parameters"));
    }
    if (method === "Target.setDiscoverTargets" && this.rejectTargetDiscovery) {
      return Promise.reject(new Error("Target.setDiscoverTargets is not allowed"));
    }
    return Promise.resolve({});
  }
}

describe("DebuggerSessionManager", () => {
  it("rolls back debugger ownership when attach epoch allocation fails and allows retry", async () => {
    const transport = new FakeDebuggerTransport();
    transport.rejectDurableProbe = false;
    const gaps: EventEnvelope[] = [];
    let allocationAttempts = 0;
    const record = session();
    const manager = new DebuggerSessionManager({
      transport,
      allocateAttachEpoch: () => {
        allocationAttempts += 1;
        return allocationAttempts === 1
          ? Promise.reject(new Error("attach epoch allocation failed"))
          : Promise.resolve(attachEpochSchema.parse(13));
      },
      newGapId: () => gapIdSchema.parse("gap_attach_epoch_failed"),
      now: () => T0,
      onCoverageGap: (gap) => {
        gaps.push(gap);
        return Promise.resolve();
      },
    });

    const failed = await manager.start({ session: record });
    expect(failed).toMatchObject({ ok: false, error: { code: "DEBUGGER_ATTACH_FAILED" } });
    expect(manager.resolveCaptureContext({ tabId: record.rootTabId })).toBeNull();
    expect(transport.detachedTabs).toEqual([record.rootTabId]);

    await manager.stop(record.sessionId);
    expect(gaps.at(-1)?.payload).toMatchObject({
      kind: "capture_gap_close",
      gapId: "gap_attach_epoch_failed",
      recovery: { action: "session_stopped" },
    });

    await expect(manager.start({ session: record })).resolves.toEqual({ ok: true });
    expect(transport.attachedTabs).toEqual([record.rootTabId, record.rootTabId]);
    expect(manager.resolveCaptureContext({ tabId: record.rootTabId })).toMatchObject({
      sessionId: record.sessionId,
      attachEpoch: 13,
    });
  });

  it("rolls back root ownership after Network.enable failure and allows retry", async () => {
    const transport = new FakeDebuggerTransport();
    transport.rejectDurableProbe = false;
    transport.rejectRootNetworkEnable = true;
    const record = session();
    const manager = new DebuggerSessionManager({
      transport,
      allocateAttachEpoch: () => Promise.resolve(attachEpochSchema.parse(14)),
      newGapId: () => gapIdSchema.parse("gap_root_enable_failed"),
      now: () => T0,
      onCoverageGap: () => Promise.resolve(),
    });

    await expect(manager.start({ session: record })).resolves.toMatchObject({ ok: false });
    expect(manager.resolveCaptureContext({ tabId: record.rootTabId })).toBeNull();
    expect(transport.detachedTabs).toEqual([record.rootTabId]);

    transport.rejectRootNetworkEnable = false;
    await expect(manager.start({ session: record })).resolves.toEqual({ ok: true });
    expect(transport.attachedTabs).toEqual([record.rootTabId, record.rootTabId]);
    expect(manager.resolveCaptureContext({ tabId: record.rootTabId })).not.toBeNull();
  });

  it("degrades unsupported root target discovery once without blocking debugger attach", async () => {
    const transport = new FakeDebuggerTransport();
    transport.rejectDurableProbe = false;
    transport.rejectTargetDiscovery = true;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const manager = new DebuggerSessionManager({
      transport,
      allocateAttachEpoch: (_sessionId, tabId) =>
        Promise.resolve(attachEpochSchema.parse(tabId === 7 ? 1 : 2)),
      newGapId: () => gapIdSchema.parse("gap_discovery_optional"),
      now: () => T0,
      onCoverageGap: () => Promise.resolve(),
    });
    const record = session();

    const rootResult = await manager.start({ session: record });
    const derivedResult = await manager.attachTab(record.sessionId, extTabIdSchema.parse(8));

    expect(rootResult).toEqual({ ok: true });
    expect(derivedResult).toEqual({ ok: true });
    expect(transport.detachedTabs).toEqual([]);
    expect(
      transport.commands.filter(({ method }) => method === "Target.setDiscoverTargets"),
    ).toHaveLength(1);
    expect(
      transport.commands.filter(({ method }) => method === "Target.setAutoAttach"),
    ).toHaveLength(2);
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });

  it("attaches a derived top-level tab as an independent root session", async () => {
    const transport = new FakeDebuggerTransport();
    transport.rejectDurableProbe = false;
    const manager = new DebuggerSessionManager({
      transport,
      allocateAttachEpoch: (_sessionId, tabId) =>
        Promise.resolve(attachEpochSchema.parse(tabId === 9 ? 1 : 2)),
      onCoverageGap: () => Promise.resolve(),
    });
    const attachTab = (
      manager as unknown as Partial<{
        attachTab: (sessionId: SessionRecord["sessionId"], tabId: SessionRecord["rootTabId"]) => Promise<unknown>;
      }>
    ).attachTab;
    expect(typeof attachTab).toBe("function");
    if (attachTab === undefined) {
      return;
    }

    const record = session();
    await manager.start({ session: record });
    await attachTab.call(manager, record.sessionId, extTabIdSchema.parse(10));
    await manager.stop(record.sessionId);

    expect(transport.attachedTabs).toEqual([9, 10]);
    expect(transport.detachedTabs).toEqual([9, 10]);
  });

  it("feature-probes durable messages and recursively enables each flat child session once", async () => {
    const transport = new FakeDebuggerTransport();
    const gaps: EventEnvelope[] = [];
    const manager = new DebuggerSessionManager({
      transport,
      allocateAttachEpoch: () => Promise.resolve(attachEpochSchema.parse(4)),
      now: () => T0,
      onCoverageGap: (gap) => {
        gaps.push(gap);
        return Promise.resolve();
      },
    });

    await expect(manager.start({ session: session() })).resolves.toEqual({ ok: true });
    expect(transport.attachedTabs).toEqual([9]);
    const networkCommands = transport.commands.filter(
      (command) => command.method === "Network.enable",
    );
    expect(networkCommands).toHaveLength(2);
    expect(networkCommands[0]?.target).toEqual({ tabId: 9 });
    expect(networkCommands[0]?.params).toMatchObject({ enableDurableMessages: true });
    expect(networkCommands[1]).toMatchObject({ target: { tabId: 9 }, params: {} });
    expect(transport.commands).toContainEqual(
      expect.objectContaining({
        target: { tabId: 9 },
        method: "Target.setAutoAttach",
        params: {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        },
      }),
    );
    expect(transport.commands).toContainEqual({
      target: { tabId: 9 },
      method: "Target.setDiscoverTargets",
      params: { discover: true },
    });

    const childSessionId = cdpSessionIdSchema.parse("child-worker-1");
    const childParams = {
      sessionId: childSessionId,
      targetInfo: { targetId: "target-worker-1", type: "worker" },
    };
    await manager.handleEvent({ tabId: extTabIdSchema.parse(9) }, "Target.attachedToTarget", childParams);
    await manager.handleEvent({ tabId: extTabIdSchema.parse(9) }, "Target.attachedToTarget", childParams);

    const childCommands = transport.commands.filter(
      (command) => command.target.sessionId === childSessionId,
    );
    expect(childCommands.map((command) => command.method)).toEqual([
      "Network.enable",
      "Target.setAutoAttach",
    ]);
    const resolveCaptureContext = (
      manager as unknown as Partial<{
        resolveCaptureContext: (source: DebuggerCommandTarget) => unknown;
      }>
    ).resolveCaptureContext;
    expect(typeof resolveCaptureContext).toBe("function");
    if (resolveCaptureContext !== undefined) {
      expect(resolveCaptureContext.call(manager, { tabId: extTabIdSchema.parse(9) })).toEqual({
        sessionId: "ses-debugger",
        tabId: 9,
        attachEpoch: 4,
      });
      expect(
        resolveCaptureContext.call(manager, {
          tabId: extTabIdSchema.parse(9),
          sessionId: childSessionId,
        }),
      ).toEqual({
        sessionId: "ses-debugger",
        tabId: 9,
        attachEpoch: 4,
        childSessionId,
      });
      expect(
        resolveCaptureContext.call(manager, {
          tabId: extTabIdSchema.parse(9),
          sessionId: cdpSessionIdSchema.parse("unknown-child"),
        }),
      ).toBeNull();
    }
    expect(gaps).toEqual([]);
  });

  it("reports child enable failure as a target-scoped CaptureGap record", async () => {
    const transport = new FakeDebuggerTransport();
    transport.rejectDurableProbe = false;
    transport.rejectChildSessionId = "child-oopif-failed";
    const gaps: EventEnvelope[] = [];
    const manager = new DebuggerSessionManager({
      transport,
      allocateAttachEpoch: () => Promise.resolve(attachEpochSchema.parse(7)),
      newGapId: () => gapIdSchema.parse("gap_child_enable_failed"),
      now: () => T0,
      onCoverageGap: (gap) => {
        gaps.push(gap);
        return Promise.resolve();
      },
    });
    await manager.start({ session: session() });

    const childParams = {
      sessionId: "child-oopif-failed",
      targetInfo: { targetId: "target-oopif-failed", type: "iframe" },
    };
    await manager.handleEvent(
      { tabId: extTabIdSchema.parse(9) },
      "Target.attachedToTarget",
      childParams,
    );
    transport.rejectChildSessionId = null;
    await manager.handleEvent(
      { tabId: extTabIdSchema.parse(9) },
      "Target.attachedToTarget",
      childParams,
    );

    expect(gaps).toEqual([
      expect.objectContaining({
        source: "service_worker",
        sessionId: "ses-debugger",
        scope: { tabId: 9 },
        payload: {
          kind: "capture_gap_open",
          record: {
            schemaVersion: SCHEMA_VERSION,
            gapId: "gap_child_enable_failed",
            scope: {
              sessionId: "ses-debugger",
              tabId: 9,
              collector: "debugger_network",
              cdpTarget: {
                targetId: "target-oopif-failed",
                sessionId: "child-oopif-failed",
                attachEpoch: 7,
              },
            },
            reason: "child_target_enable_delay",
            observedStartedAt: T0,
            boundaryConfidence: "exact",
            recoverable: true,
            affectedCapabilities: ["network_metadata", "network_bodies"],
            detail: "Error: child Network.enable failed",
          },
        },
      }),
      expect.objectContaining({
        sessionId: "ses-debugger",
        payload: {
          kind: "capture_gap_close",
          gapId: "gap_child_enable_failed",
          observedEndedAt: T0,
          recovery: {
            action: "reattached",
            newAttachEpoch: 7,
            recoveredAt: T0,
          },
        },
      }),
    ]);
  });

  it("fires the child-enable-failed hook with the child capture context and cause", async () => {
    const transport = new FakeDebuggerTransport();
    transport.rejectDurableProbe = false;
    transport.rejectChildSessionId = "child-hook-failed";
    const gaps: EventEnvelope[] = [];
    const hookCalls: Array<{ context: unknown; cause: string }> = [];
    const manager = new DebuggerSessionManager({
      transport,
      allocateAttachEpoch: () => Promise.resolve(attachEpochSchema.parse(8)),
      newGapId: () => gapIdSchema.parse("gap_child_hook"),
      now: () => T0,
      onCoverageGap: (gap) => {
        gaps.push(gap);
        return Promise.resolve();
      },
    });
    manager.setOnChildNetworkEnableFailed((context, cause) => {
      hookCalls.push({ context, cause });
    });
    await manager.start({ session: session() });

    await manager.handleEvent(
      { tabId: extTabIdSchema.parse(9) },
      "Target.attachedToTarget",
      {
        sessionId: "child-hook-failed",
        targetInfo: { targetId: "target-hook-failed", type: "worker" },
      },
    );

    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.payload).toMatchObject({ kind: "capture_gap_open" });
    expect(hookCalls).toEqual([
      {
        context: {
          sessionId: "ses-debugger",
          tabId: 9,
          attachEpoch: 8,
          childSessionId: "child-hook-failed",
        },
        cause: "Error: child Network.enable failed",
      },
    ]);
  });

  it("does not fire the child-enable-failed hook when enable succeeds", async () => {
    const transport = new FakeDebuggerTransport();
    transport.rejectDurableProbe = false;
    const gaps: EventEnvelope[] = [];
    const hookCalls: string[] = [];
    const manager = new DebuggerSessionManager({
      transport,
      allocateAttachEpoch: () => Promise.resolve(attachEpochSchema.parse(8)),
      newGapId: () => gapIdSchema.parse("gap_child_ok"),
      now: () => T0,
      onCoverageGap: (gap) => {
        gaps.push(gap);
        return Promise.resolve();
      },
    });
    manager.setOnChildNetworkEnableFailed((_context, cause) => {
      hookCalls.push(cause);
    });
    await manager.start({ session: session() });

    await manager.handleEvent(
      { tabId: extTabIdSchema.parse(9) },
      "Target.attachedToTarget",
      {
        sessionId: "child-hook-ok",
        targetInfo: { targetId: "target-hook-ok", type: "worker" },
      },
    );

    expect(gaps).toEqual([]);
    expect(hookCalls).toEqual([]);
  });

  it("closes a derived-tab attach delay after a successful retry", async () => {
    const transport = new FakeDebuggerTransport();
    transport.rejectDurableProbe = false;
    const gaps: EventEnvelope[] = [];
    const record = session();
    const manager = new DebuggerSessionManager({
      transport,
      allocateAttachEpoch: (_sessionId, tabId) =>
        Promise.resolve(attachEpochSchema.parse(tabId === 9 ? 1 : 2)),
      newGapId: () => gapIdSchema.parse("gap_new_tab_attach"),
      now: () => T0,
      onCoverageGap: (gap) => {
        gaps.push(gap);
        return Promise.resolve();
      },
    });
    await manager.start({ session: record });
    const derivedTabId = extTabIdSchema.parse(10);
    transport.rejectAttachTabs.add(derivedTabId);

    await expect(manager.attachTab(record.sessionId, derivedTabId)).resolves.toMatchObject({
      ok: false,
    });
    transport.rejectAttachTabs.delete(derivedTabId);
    await expect(manager.attachTab(record.sessionId, derivedTabId)).resolves.toEqual({ ok: true });

    expect(gaps).toHaveLength(2);
    expect(gaps[0]?.payload).toMatchObject({
      kind: "capture_gap_open",
      record: {
        gapId: "gap_new_tab_attach",
        reason: "new_tab_attach_delay",
        recoverable: true,
      },
    });
    expect(gaps[1]?.payload).toEqual({
        kind: "capture_gap_close",
        gapId: "gap_new_tab_attach",
        observedEndedAt: T0,
        recovery: {
          action: "reattached",
          newAttachEpoch: 2,
          recoveredAt: T0,
        },
    });
  });

  it("opens and closes a target-scoped gap across child detach and reattach", async () => {
    const transport = new FakeDebuggerTransport();
    transport.rejectDurableProbe = false;
    const gaps: EventEnvelope[] = [];
    const manager = new DebuggerSessionManager({
      transport,
      allocateAttachEpoch: () => Promise.resolve(attachEpochSchema.parse(8)),
      newGapId: () => gapIdSchema.parse("gap_child_detached"),
      now: () => T0,
      onCoverageGap: (gap) => {
        gaps.push(gap);
        return Promise.resolve();
      },
    });
    await manager.start({ session: session() });
    await manager.handleEvent({ tabId: extTabIdSchema.parse(9) }, "Target.attachedToTarget", {
      sessionId: "child-oopif-before-detach",
      targetInfo: { targetId: "target-oopif-stable", type: "iframe" },
    });
    await manager.handleEvent({ tabId: extTabIdSchema.parse(9) }, "Target.detachedFromTarget", {
      sessionId: "child-oopif-before-detach",
    });
    const restoredContext = await manager.handleEvent(
      { tabId: extTabIdSchema.parse(9) },
      "Target.attachedToTarget",
      {
        sessionId: "child-oopif-after-detach",
        targetInfo: { targetId: "target-oopif-stable", type: "iframe" },
      },
    );

    expect(restoredContext).toEqual({
      sessionId: "ses-debugger",
      tabId: 9,
      attachEpoch: 8,
      childSessionId: "child-oopif-after-detach",
    });
    expect(gaps).toHaveLength(2);
    expect(gaps[0]?.payload).toMatchObject({
      kind: "capture_gap_open",
      record: {
        gapId: "gap_child_detached",
        reason: "debugger_detached",
        scope: {
          cdpTarget: {
            targetId: "target-oopif-stable",
            sessionId: "child-oopif-before-detach",
            attachEpoch: 8,
          },
        },
      },
    });
    expect(gaps[1]?.payload).toMatchObject({
      kind: "capture_gap_close",
      gapId: "gap_child_detached",
      recovery: { action: "reattached", newAttachEpoch: 8 },
    });
  });

  it("classifies orphan tails as explained only while an attach gap is open", async () => {
    const transport = new FakeDebuggerTransport();
    transport.rejectDurableProbe = false;
    const manager = new DebuggerSessionManager({
      transport,
      allocateAttachEpoch: () => Promise.resolve(attachEpochSchema.parse(8)),
      newGapId: () => gapIdSchema.parse("gap_child_orphan_classifier"),
      now: () => T0,
      onCoverageGap: () => Promise.resolve(),
    });
    const record = session();
    await manager.start({ session: record });
    const rootContext = manager.resolveCaptureContext({ tabId: record.rootTabId });
    if (rootContext === null) {
      throw new Error("expected root debugger context");
    }
    await manager.handleEvent({ tabId: record.rootTabId }, "Target.attachedToTarget", {
      sessionId: "child-orphan-classifier",
      targetInfo: { targetId: "target-orphan-classifier", type: "iframe" },
    });
    await manager.handleEvent({ tabId: record.rootTabId }, "Target.detachedFromTarget", {
      sessionId: "child-orphan-classifier",
    });

    expect(manager.classifyOrphanNetworkEvent(rootContext)).toBe("explained");

    await manager.handleEvent({ tabId: record.rootTabId }, "Target.targetDestroyed", {
      targetId: "target-orphan-classifier",
    });
    expect(manager.classifyOrphanNetworkEvent(rootContext)).toBe("unexplained");
  });

  it("terminally closes a detached child gap when CDP destroys the target", async () => {
    const transport = new FakeDebuggerTransport();
    transport.rejectDurableProbe = false;
    const gaps: EventEnvelope[] = [];
    let now = T0;
    const manager = new DebuggerSessionManager({
      transport,
      allocateAttachEpoch: () => Promise.resolve(attachEpochSchema.parse(9)),
      newGapId: () => gapIdSchema.parse("gap_child_destroyed"),
      now: () => now,
      onCoverageGap: (gap) => {
        gaps.push(gap);
        return Promise.resolve();
      },
    });
    await manager.start({ session: session() });
    await manager.handleEvent({ tabId: extTabIdSchema.parse(9) }, "Target.attachedToTarget", {
      sessionId: "child-worker-destroyed",
      targetInfo: { targetId: "target-worker-destroyed", type: "worker" },
    });
    await manager.handleEvent({ tabId: extTabIdSchema.parse(9) }, "Target.detachedFromTarget", {
      sessionId: "child-worker-destroyed",
    });

    now = T0 + 250;
    await manager.handleEvent({ tabId: extTabIdSchema.parse(9) }, "Target.targetDestroyed", {
      targetId: "target-worker-destroyed",
    });

    expect(gaps).toHaveLength(2);
    expect(gaps[1]?.payload).toEqual({
      kind: "capture_gap_close",
      gapId: "gap_child_destroyed",
      observedEndedAt: T0 + 250,
      recovery: {
        action: "target_destroyed",
        recoveredAt: T0 + 250,
      },
    });
  });

  it("lets only one terminal path close a child gap during destroy and reattach races", async () => {
    const transport = new FakeDebuggerTransport();
    transport.rejectDurableProbe = false;
    const gaps: EventEnvelope[] = [];
    const manager = new DebuggerSessionManager({
      transport,
      allocateAttachEpoch: () => Promise.resolve(attachEpochSchema.parse(10)),
      newGapId: () => gapIdSchema.parse("gap_child_race"),
      now: () => T0,
      onCoverageGap: (gap) => {
        gaps.push(gap);
        return Promise.resolve();
      },
    });
    await manager.start({ session: session() });
    await manager.handleEvent({ tabId: extTabIdSchema.parse(9) }, "Target.attachedToTarget", {
      sessionId: "child-race-before",
      targetInfo: { targetId: "target-race", type: "iframe" },
    });
    await manager.handleEvent({ tabId: extTabIdSchema.parse(9) }, "Target.detachedFromTarget", {
      sessionId: "child-race-before",
    });

    await Promise.all([
      manager.handleEvent({ tabId: extTabIdSchema.parse(9) }, "Target.targetDestroyed", {
        targetId: "target-race",
      }),
      manager.handleEvent({ tabId: extTabIdSchema.parse(9) }, "Target.attachedToTarget", {
        sessionId: "child-race-after",
        targetInfo: { targetId: "target-race", type: "iframe" },
      }),
    ]);

    const closes = gaps.filter((gap) => gap.payload.kind === "capture_gap_close");
    expect(closes).toHaveLength(1);
  });

  it.each([
    ["stop", "session_stopped"],
    ["disconnect", "collector_disconnected"],
  ] as const)(
    "%s terminally closes every open child gap and remains idempotent",
    async (operation, expectedAction) => {
      const transport = new FakeDebuggerTransport();
      transport.rejectDurableProbe = false;
      const gaps: EventEnvelope[] = [];
      let gapIndex = 0;
      const gapIds = ["gap_stop_worker", "gap_stop_iframe"] as const;
      const manager = new DebuggerSessionManager({
        transport,
        allocateAttachEpoch: () => Promise.resolve(attachEpochSchema.parse(11)),
        newGapId: () => gapIdSchema.parse(gapIds[gapIndex++] ?? "unexpected_gap"),
        now: () => T0,
        onCoverageGap: (gap) => {
          gaps.push(gap);
          return Promise.resolve();
        },
      });
      const record = session();
      await manager.start({ session: record });
      for (const [childSessionId, targetId, type] of [
        ["child-stop-worker", "target-stop-worker", "worker"],
        ["child-stop-iframe", "target-stop-iframe", "iframe"],
      ] as const) {
        await manager.handleEvent({ tabId: record.rootTabId }, "Target.attachedToTarget", {
          sessionId: childSessionId,
          targetInfo: { targetId, type },
        });
        await manager.handleEvent({ tabId: record.rootTabId }, "Target.detachedFromTarget", {
          sessionId: childSessionId,
        });
      }

      await manager[operation](record.sessionId);
      await manager[operation](record.sessionId);

      const closes = gaps.filter((gap) => gap.payload.kind === "capture_gap_close");
      expect(closes).toHaveLength(2);
      for (const close of closes) {
        if (close.payload.kind !== "capture_gap_close") {
          throw new Error("expected a capture gap close payload");
        }
        expect(close.payload.recovery?.action).toBe(expectedAction);
      }
    },
  );

  it("keeps a root gap retryable when its terminal close persistence fails", async () => {
    const transport = new FakeDebuggerTransport();
    transport.rejectDurableProbe = false;
    const record = session();
    const closeAttempts: EventEnvelope[] = [];
    let rejectNextClose = true;
    const manager = new DebuggerSessionManager({
      transport,
      allocateAttachEpoch: () => Promise.resolve(attachEpochSchema.parse(15)),
      newGapId: () => gapIdSchema.parse("gap_root_close_retry"),
      now: () => T0,
      onCoverageGap: (gap) => {
        if (gap.payload.kind !== "capture_gap_close") {
          return Promise.resolve();
        }
        closeAttempts.push(gap);
        if (rejectNextClose) {
          rejectNextClose = false;
          return Promise.reject(new Error("root gap close persistence failed"));
        }
        return Promise.resolve();
      },
    });
    await manager.start({ session: record });
    await manager.handleDetach({ tabId: record.rootTabId }, "root detached");

    await expect(manager.stop(record.sessionId)).rejects.toThrow(
      "root gap close persistence failed",
    );
    await expect(manager.stop(record.sessionId)).resolves.toBeUndefined();

    expect(closeAttempts).toHaveLength(2);
    for (const attempt of closeAttempts) {
      expect(attempt.payload).toMatchObject({
        kind: "capture_gap_close",
        gapId: "gap_root_close_retry",
        recovery: { action: "session_stopped" },
      });
    }
  });

  it("keeps a child gap retryable when its terminal close persistence fails", async () => {
    const transport = new FakeDebuggerTransport();
    transport.rejectDurableProbe = false;
    const record = session();
    const closeAttempts: EventEnvelope[] = [];
    let rejectNextClose = true;
    const manager = new DebuggerSessionManager({
      transport,
      allocateAttachEpoch: () => Promise.resolve(attachEpochSchema.parse(16)),
      newGapId: () => gapIdSchema.parse("gap_child_close_retry"),
      now: () => T0,
      onCoverageGap: (gap) => {
        if (gap.payload.kind !== "capture_gap_close") {
          return Promise.resolve();
        }
        closeAttempts.push(gap);
        if (rejectNextClose) {
          rejectNextClose = false;
          return Promise.reject(new Error("child gap close persistence failed"));
        }
        return Promise.resolve();
      },
    });
    await manager.start({ session: record });
    await manager.handleEvent({ tabId: record.rootTabId }, "Target.attachedToTarget", {
      sessionId: "child-close-retry",
      targetInfo: { targetId: "target-close-retry", type: "iframe" },
    });
    await manager.handleEvent({ tabId: record.rootTabId }, "Target.detachedFromTarget", {
      sessionId: "child-close-retry",
    });

    await expect(manager.stop(record.sessionId)).rejects.toThrow(
      "child gap close persistence failed",
    );
    await expect(manager.stop(record.sessionId)).resolves.toBeUndefined();

    expect(closeAttempts).toHaveLength(2);
    for (const attempt of closeAttempts) {
      expect(attempt.payload).toMatchObject({
        kind: "capture_gap_close",
        gapId: "gap_child_close_retry",
        recovery: { action: "session_stopped" },
      });
    }
  });

  it.each([
    ["stop", "session_stopped"],
    ["disconnect", "collector_disconnected"],
  ] as const)(
    "%s terminally closes every open root gap and remains idempotent",
    async (operation, expectedAction) => {
      const transport = new FakeDebuggerTransport();
      transport.rejectDurableProbe = false;
      const gaps: EventEnvelope[] = [];
      const record = session();
      const manager = new DebuggerSessionManager({
        transport,
        allocateAttachEpoch: () => Promise.resolve(attachEpochSchema.parse(12)),
        newGapId: () => gapIdSchema.parse("gap_root_terminal"),
        now: () => T0,
        onCoverageGap: (gap) => {
          gaps.push(gap);
          return Promise.resolve();
        },
      });
      await manager.start({ session: record });
      await manager.handleDetach({ tabId: record.rootTabId }, "root detached");

      await manager[operation](record.sessionId);
      await manager[operation](record.sessionId);

      const closes = gaps.filter((gap) => gap.payload.kind === "capture_gap_close");
      expect(closes).toHaveLength(1);
      expect(closes[0]?.payload).toEqual({
        kind: "capture_gap_close",
        gapId: "gap_root_terminal",
        observedEndedAt: T0,
        recovery: { action: expectedAction, recoveredAt: T0 },
      });
    },
  );

  it("tears down idempotently and reports an unexpected root detach as a scoped gap", async () => {
    const transport = new FakeDebuggerTransport();
    transport.rejectDurableProbe = false;
    const gaps: EventEnvelope[] = [];
    const record = session();
    const manager = new DebuggerSessionManager({
      transport,
      allocateAttachEpoch: () => Promise.resolve(attachEpochSchema.parse(2)),
      newGapId: () => gapIdSchema.parse("gap_root_detached"),
      now: () => T0,
      onCoverageGap: (gap) => {
        gaps.push(gap);
        return Promise.resolve();
      },
    });
    await manager.start({ session: record });

    await manager.handleDetach({ tabId: record.rootTabId }, "canceled_by_user");
    await manager.handleDetach({ tabId: record.rootTabId }, "canceled_by_user");

    expect(gaps).toEqual([
      expect.objectContaining({
        source: "service_worker",
        sessionId: record.sessionId,
        scope: { tabId: record.rootTabId },
        payload: {
          kind: "capture_gap_open",
          record: {
            schemaVersion: SCHEMA_VERSION,
            gapId: "gap_root_detached",
            scope: {
              sessionId: record.sessionId,
              tabId: record.rootTabId,
              collector: "debugger_network",
              cdpTarget: { attachEpoch: 2 },
            },
            reason: "debugger_detached",
            observedStartedAt: T0,
            boundaryConfidence: "exact",
            recoverable: true,
            affectedCapabilities: ["network_metadata", "network_bodies"],
            detail: "canceled_by_user",
          },
        },
      }),
    ]);
    await manager.stop(record.sessionId);
    await manager.stop(record.sessionId);
    expect(transport.detachedTabs).toEqual([]);
  });
});
