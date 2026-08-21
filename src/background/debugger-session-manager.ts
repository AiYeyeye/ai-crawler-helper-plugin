import { z } from "zod";
import type {
  CaptureCollector,
  CollectorStartContext,
  CollectorStartResult,
} from "../core/collector-contracts";
import {
  DEFAULT_RESPONSE_BODY_MAX_BYTES,
  DEFAULT_RESPONSE_BODY_SOFT_BUDGET_BYTES,
} from "../core/config";
import { businessError } from "../shared/errors";
import { SCHEMA_VERSION } from "../schemas/common";
import {
  captureGapRecordSchema,
  type CaptureGapReason,
  type CaptureGapRecovery,
} from "../schemas/capture-gap";
import { eventEnvelopeSchema, type EventEnvelope } from "../schemas/event-envelope";
import {
  cdpSessionIdSchema,
  cdpTargetIdSchema,
  extTabIdSchema,
  newEventId,
  newGapId,
  type AttachEpoch,
  type CdpSessionId,
  type CdpTargetId,
  type ExtTabId,
  type EventId,
  type GapId,
  type SessionId,
} from "../shared/ids";

export interface DebuggerCommandTarget {
  tabId: ExtTabId;
  sessionId?: CdpSessionId;
}

export interface DebuggerCaptureSessionContext {
  sessionId: SessionId;
  tabId: ExtTabId;
  attachEpoch: AttachEpoch;
  childSessionId?: CdpSessionId;
}

export type OrphanNetworkEventClassification = "explained" | "unexplained";

export interface DebuggerTransport {
  attach(tabId: number): Promise<void>;
  detach(tabId: number): Promise<void>;
  sendCommand(
    target: DebuggerCommandTarget,
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}

export interface DebuggerSessionManagerOptions {
  transport: DebuggerTransport;
  allocateAttachEpoch: (sessionId: SessionId, tabId: ExtTabId) => Promise<AttachEpoch>;
  onCoverageGap: (envelope: EventEnvelope) => Promise<void>;
  /**
   * Optional, late-bound via {@link setOnChildNetworkEnableFailed}: fired after
   * a child target's network enable failed (child_target_enable_delay gap is
   * already open). Lets the composition root discard the child session's
   * buffered network events immediately instead of waiting out the pending
   * deadline. The context carries the child CDP session id.
   */
  onChildNetworkEnableFailed?: (context: DebuggerCaptureSessionContext, cause: string) => void;
  newEventId?: () => EventId;
  newGapId?: () => GapId;
  now?: () => number;
}

interface ChildSessionState {
  sessionId: CdpSessionId;
  targetId: CdpTargetId;
  targetType: string;
}

interface RootSessionState {
  sessionId: SessionId;
  tabId: ExtTabId;
  attachEpoch: AttachEpoch;
  children: Map<CdpSessionId, ChildSessionState>;
}

interface OpenRootGapState {
  gapId: GapId;
  root: Pick<RootSessionState, "sessionId" | "tabId"> & { attachEpoch?: AttachEpoch };
}

interface OpenChildGapState {
  gapId: GapId;
  root: Pick<RootSessionState, "sessionId" | "tabId" | "attachEpoch">;
  targetId: CdpTargetId;
  opened: Promise<void>;
}

const attachedToTargetSchema = z
  .object({
    sessionId: cdpSessionIdSchema,
    targetInfo: z
      .object({
        targetId: cdpTargetIdSchema,
        type: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

const detachedFromTargetSchema = z
  .object({ sessionId: cdpSessionIdSchema })
  .passthrough();

const targetDestroyedSchema = z
  .object({ targetId: cdpTargetIdSchema })
  .passthrough();

const debuggerSourceSchema = z
  .object({
    tabId: extTabIdSchema.optional(),
    sessionId: cdpSessionIdSchema.optional(),
  })
  .passthrough();

const AUTO_ATTACH_PARAMS = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
} as const;

const DISCOVER_TARGETS_PARAMS = { discover: true } as const;

const DURABLE_NETWORK_PARAMS = {
  maxTotalBufferSize: DEFAULT_RESPONSE_BODY_SOFT_BUDGET_BYTES,
  maxResourceBufferSize: DEFAULT_RESPONSE_BODY_MAX_BYTES,
  maxPostDataSize: DEFAULT_RESPONSE_BODY_MAX_BYTES,
  enableDurableMessages: true,
} as const;

type DurableMessagesSupport = "unknown" | "supported" | "unsupported";
type TargetDiscoverySupport = "unknown" | "supported" | "unsupported";

const describeCause = (cause: unknown): string => {
  if (cause instanceof Error) {
    return cause.message === "" ? cause.name : `${cause.name}: ${cause.message}`;
  }
  return typeof cause === "string" && cause !== "" ? cause : "unknown";
};

/** Root debugger + flat child-session lifecycle. Network events are routed separately. */
export class DebuggerSessionManager implements CaptureCollector {
  readonly name = "debugger_network" as const;

  private readonly transport: DebuggerTransport;
  private readonly allocateAttachEpoch: DebuggerSessionManagerOptions["allocateAttachEpoch"];
  private readonly onCoverageGap: DebuggerSessionManagerOptions["onCoverageGap"];
  private onChildNetworkEnableFailed: DebuggerSessionManagerOptions["onChildNetworkEnableFailed"];
  private readonly makeEventId: () => EventId;
  private readonly makeGapId: () => GapId;
  private readonly now: () => number;
  private readonly rootsBySession = new Map<SessionId, Map<ExtTabId, RootSessionState>>();
  private readonly rootsByTab = new Map<ExtTabId, RootSessionState>();
  private readonly openRootGaps = new Map<string, OpenRootGapState>();
  private readonly openChildGaps = new Map<string, OpenChildGapState>();
  private durableMessagesSupport: DurableMessagesSupport = "unknown";
  private targetDiscoverySupport: TargetDiscoverySupport = "unknown";
  private coverageGapSourceSeq = 0;

  constructor(options: DebuggerSessionManagerOptions) {
    this.transport = options.transport;
    this.allocateAttachEpoch = options.allocateAttachEpoch;
    this.onCoverageGap = options.onCoverageGap;
    this.onChildNetworkEnableFailed = options.onChildNetworkEnableFailed;
    this.makeEventId = options.newEventId ?? newEventId;
    this.makeGapId = options.newGapId ?? newGapId;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Late-binds the child-enable-failure hook so the composition root can wire
   * the controller after both objects exist (they reference each other).
   */
  setOnChildNetworkEnableFailed(
    hook: NonNullable<DebuggerSessionManagerOptions["onChildNetworkEnableFailed"]>,
  ): void {
    this.onChildNetworkEnableFailed = hook;
  }

  async start(context: CollectorStartContext): Promise<CollectorStartResult> {
    return this.attachRoot(context.session.sessionId, context.session.rootTabId, "attach_delay");
  }

  async attachTab(sessionId: SessionId, tabId: ExtTabId): Promise<CollectorStartResult> {
    return this.attachRoot(sessionId, tabId, "new_tab_attach_delay");
  }

  private async attachRoot(
    sessionId: SessionId,
    tabId: ExtTabId,
    failureReason: "attach_delay" | "new_tab_attach_delay",
  ): Promise<CollectorStartResult> {
    if (this.rootsBySession.get(sessionId)?.has(tabId) === true) {
      return { ok: true };
    }
    const existingTab = this.rootsByTab.get(tabId);
    if (existingTab !== undefined) {
      return {
        ok: false,
        error: businessError(
          "DEBUGGER_ATTACH_FAILED",
          "The tab is already attached to another recording session.",
          { tabId },
        ),
      };
    }
    let debuggerAttached = false;
    let root: RootSessionState | undefined;
    try {
      await this.transport.attach(tabId);
      debuggerAttached = true;
      const attachEpoch = await this.allocateAttachEpoch(sessionId, tabId);
      root = {
        sessionId,
        tabId,
        attachEpoch,
        children: new Map(),
      };
      const sessionRoots =
        this.rootsBySession.get(root.sessionId) ?? new Map<ExtTabId, RootSessionState>();
      sessionRoots.set(root.tabId, root);
      this.rootsBySession.set(root.sessionId, sessionRoots);
      this.rootsByTab.set(root.tabId, root);
      await this.enableTarget({ tabId });
      await this.closeRootGap(root);
      return { ok: true };
    } catch (cause: unknown) {
      if (root !== undefined) {
        this.removeRoot(root);
      }
      if (debuggerAttached) {
        await this.transport.detach(tabId).catch(() => undefined);
      }
      const detail = describeCause(cause);
      console.error(
        `[ai-crawler-helper] debugger attach failed (tab ${String(tabId)}): ${detail}`,
        cause,
      );
      await this.openRootGap(
        sessionId,
        tabId,
        failureReason,
        detail,
        root?.attachEpoch,
      );
      return {
        ok: false,
        error: businessError(
          "DEBUGGER_ATTACH_FAILED",
          "Unable to attach and enable the debugger network collector.",
          { tabId, cause: detail },
        ),
      };
    }
  }

  async stop(sessionId: SessionId): Promise<void> {
    return this.teardown(sessionId, "session_stopped");
  }

  disconnect(sessionId: SessionId): Promise<void> {
    return this.teardown(sessionId, "collector_disconnected");
  }

  private async teardown(
    sessionId: SessionId,
    action: Extract<
      CaptureGapRecovery["action"],
      "session_stopped" | "collector_disconnected"
    >,
  ): Promise<void> {
    const closeResults = await Promise.allSettled([
      this.closeChildGapsForSession(sessionId, action),
      this.closeRootGapsForSession(sessionId, action),
    ]);
    const roots = [...(this.rootsBySession.get(sessionId)?.values() ?? [])];
    for (const root of roots) {
      this.removeRoot(root);
    }
    await Promise.all(
      roots.map((root) => this.transport.detach(root.tabId).catch(() => undefined)),
    );
    const closeFailure = closeResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (closeFailure !== undefined) {
      throw closeFailure.reason instanceof Error
        ? closeFailure.reason
        : new Error("debugger CaptureGap terminal close failed");
    }
  }

  resolveCaptureContext(
    source: DebuggerCommandTarget,
  ): DebuggerCaptureSessionContext | null {
    const root = this.rootsByTab.get(source.tabId);
    if (root === undefined) {
      return null;
    }
    if (source.sessionId !== undefined && !root.children.has(source.sessionId)) {
      return null;
    }
    return {
      sessionId: root.sessionId,
      tabId: root.tabId,
      attachEpoch: root.attachEpoch,
      ...(source.sessionId === undefined ? {} : { childSessionId: source.sessionId }),
    };
  }

  classifyOrphanNetworkEvent(
    context: DebuggerCaptureSessionContext,
  ): OrphanNetworkEventClassification {
    if (this.openRootGaps.has(this.rootGapKey(context.sessionId, context.tabId))) {
      return "explained";
    }
    for (const gap of this.openChildGaps.values()) {
      if (
        gap.root.sessionId === context.sessionId &&
        gap.root.tabId === context.tabId &&
        gap.root.attachEpoch === context.attachEpoch
      ) {
        return "explained";
      }
    }
    return "unexplained";
  }

  async handleEvent(
    source: DebuggerCommandTarget,
    method: string,
    params: unknown,
  ): Promise<DebuggerCaptureSessionContext | null> {
    const root = this.rootsByTab.get(source.tabId);
    if (root === undefined) {
      return null;
    }
    if (method === "Target.attachedToTarget") {
      const attached = attachedToTargetSchema.parse(params);
      if (root.children.has(attached.sessionId)) {
        return null;
      }
      const child: ChildSessionState = {
        sessionId: attached.sessionId,
        targetId: attached.targetInfo.targetId,
        targetType: attached.targetInfo.type,
      };
      root.children.set(child.sessionId, child);
      try {
        await this.enableTarget({ tabId: root.tabId, sessionId: child.sessionId });
        await this.closeChildGap(root, child);
        return {
          sessionId: root.sessionId,
          tabId: root.tabId,
          attachEpoch: root.attachEpoch,
          childSessionId: child.sessionId,
        };
      } catch (cause: unknown) {
        root.children.delete(child.sessionId);
        await this.openChildGap(
          root,
          "child_target_enable_delay",
          child,
          describeCause(cause),
        );
        this.onChildNetworkEnableFailed?.(
          {
            sessionId: root.sessionId,
            tabId: root.tabId,
            attachEpoch: root.attachEpoch,
            childSessionId: child.sessionId,
          },
          describeCause(cause),
        );
      }
      return null;
    }
    if (method === "Target.detachedFromTarget") {
      const detached = detachedFromTargetSchema.parse(params);
      const child = root.children.get(detached.sessionId);
      root.children.delete(detached.sessionId);
      if (child !== undefined) {
        await this.openChildGap(
          root,
          "debugger_detached",
          child,
          `child target detached: ${child.targetType}`,
        );
      }
      return null;
    }
    if (method === "Target.targetDestroyed") {
      const destroyed = targetDestroyedSchema.parse(params);
      await this.closeChildGapByTarget(root, destroyed.targetId, {
        action: "target_destroyed",
        recoveredAt: this.now(),
      });
    }
    return null;
  }

  async handleDetach(source: DebuggerCommandTarget, reason: string): Promise<void> {
    const root = this.rootsByTab.get(source.tabId);
    if (root === undefined) {
      return;
    }
    this.removeRoot(root);
    const gapKey = this.rootGapKey(root.sessionId, root.tabId);
    if (!this.openRootGaps.has(gapKey)) {
      const gapId = await this.reportCoverageGap(
        root,
        "debugger_detached",
        this.now(),
        {},
        reason,
        true,
      );
      this.openRootGaps.set(gapKey, {
        gapId,
        root: {
          sessionId: root.sessionId,
          tabId: root.tabId,
          attachEpoch: root.attachEpoch,
        },
      });
    }
  }

  private reportCoverageGap(
    root: Pick<RootSessionState, "sessionId" | "tabId"> & { attachEpoch?: AttachEpoch },
    reason: CaptureGapReason,
    observedAt: number,
    target: { sessionId?: CdpSessionId; targetId?: CdpTargetId },
    detail: string,
    recoverable: boolean,
    gapId: GapId = this.makeGapId(),
  ): Promise<GapId> {
    const record = captureGapRecordSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      gapId,
      scope: {
        sessionId: root.sessionId,
        tabId: root.tabId,
        collector: "debugger_network",
        cdpTarget: {
          ...(root.attachEpoch === undefined ? {} : { attachEpoch: root.attachEpoch }),
          ...(target.sessionId === undefined ? {} : { sessionId: target.sessionId }),
          ...(target.targetId === undefined ? {} : { targetId: target.targetId }),
        },
      },
      reason,
      observedStartedAt: observedAt,
      boundaryConfidence: "exact",
      recoverable,
      affectedCapabilities: ["network_metadata", "network_bodies"],
      detail,
    });
    const envelope = eventEnvelopeSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      eventId: this.makeEventId(),
      source: "service_worker",
      sourceSeq: this.coverageGapSourceSeq++,
      sessionId: root.sessionId,
      scope: { tabId: root.tabId },
      sourceTimestamp: observedAt,
      payload: { kind: "capture_gap_open", record },
    });
    return this.onCoverageGap(envelope).then(() => gapId);
  }

  private async openRootGap(
    sessionId: SessionId,
    tabId: ExtTabId,
    reason: "attach_delay" | "new_tab_attach_delay",
    detail: string,
    attachEpoch?: AttachEpoch,
  ): Promise<void> {
    const gapKey = this.rootGapKey(sessionId, tabId);
    if (this.openRootGaps.has(gapKey)) {
      return;
    }
    const provisional = {
      sessionId,
      tabId,
      ...(attachEpoch === undefined ? {} : { attachEpoch }),
    };
    const gapId = await this.reportCoverageGap(
      provisional,
      reason,
      this.now(),
      {},
      detail,
      true,
    );
    this.openRootGaps.set(gapKey, { gapId, root: provisional });
  }

  private async closeRootGap(root: RootSessionState): Promise<void> {
    const key = this.rootGapKey(root.sessionId, root.tabId);
    const state = this.openRootGaps.get(key);
    if (state === undefined) {
      return;
    }
    await this.closeCoverageGap(root, state.gapId, {
      action: "reattached",
      newAttachEpoch: root.attachEpoch,
      recoveredAt: this.now(),
    });
    this.openRootGaps.delete(key);
  }

  private async closeRootGapsForSession(
    sessionId: SessionId,
    action: Extract<
      CaptureGapRecovery["action"],
      "session_stopped" | "collector_disconnected"
    >,
  ): Promise<void> {
    const entries = [...this.openRootGaps.entries()].filter(
      ([, state]) => state.root.sessionId === sessionId,
    );
    await Promise.all(
      entries.map(async ([key, state]) => {
        await this.closeCoverageGap(state.root, state.gapId, {
          action,
          recoveredAt: this.now(),
        });
        if (this.openRootGaps.get(key) === state) {
          this.openRootGaps.delete(key);
        }
      }),
    );
  }

  private async openChildGap(
    root: RootSessionState,
    reason: Extract<CaptureGapReason, "child_target_enable_delay" | "debugger_detached">,
    child: ChildSessionState,
    detail: string,
  ): Promise<void> {
    const key = this.childGapKey(root, child.targetId);
    if (this.openChildGaps.has(key)) {
      return;
    }
    const gapId = this.makeGapId();
    const opened = this.reportCoverageGap(
      root,
      reason,
      this.now(),
      { sessionId: child.sessionId, targetId: child.targetId },
      detail,
      true,
      gapId,
    ).then(() => undefined);
    const state: OpenChildGapState = {
      gapId,
      root: {
        sessionId: root.sessionId,
        tabId: root.tabId,
        attachEpoch: root.attachEpoch,
      },
      targetId: child.targetId,
      opened,
    };
    this.openChildGaps.set(key, state);
    try {
      await opened;
    } catch (cause: unknown) {
      if (this.openChildGaps.get(key) === state) {
        this.openChildGaps.delete(key);
      }
      throw cause;
    }
  }

  private async closeChildGap(
    root: RootSessionState,
    child: ChildSessionState,
  ): Promise<void> {
    await this.closeChildGapByTarget(root, child.targetId, {
      action: "reattached",
      newAttachEpoch: root.attachEpoch,
      recoveredAt: this.now(),
    });
  }

  private async closeChildGapByTarget(
    root: Pick<RootSessionState, "sessionId" | "tabId" | "attachEpoch">,
    targetId: CdpTargetId,
    recovery: CaptureGapRecovery,
  ): Promise<void> {
    const key = this.childGapKey(root, targetId);
    const state = this.openChildGaps.get(key);
    if (state === undefined) {
      return;
    }
    this.openChildGaps.delete(key);
    let opened = false;
    try {
      await state.opened;
      opened = true;
      await this.closeCoverageGap(state.root, state.gapId, recovery);
    } catch (cause: unknown) {
      if (opened && !this.openChildGaps.has(key)) {
        this.openChildGaps.set(key, state);
      }
      throw cause;
    }
  }

  private async closeChildGapsForSession(
    sessionId: SessionId,
    action: Extract<
      CaptureGapRecovery["action"],
      "session_stopped" | "collector_disconnected"
    >,
  ): Promise<void> {
    const entries = [...this.openChildGaps.values()].filter(
      (entry) => entry.root.sessionId === sessionId,
    );
    await Promise.all(
      entries.map((entry) =>
        this.closeChildGapByTarget(entry.root, entry.targetId, {
          action,
          recoveredAt: this.now(),
        }),
      ),
    );
  }

  private closeCoverageGap(
    root: Pick<RootSessionState, "sessionId" | "tabId"> & { attachEpoch?: AttachEpoch },
    gapId: GapId,
    recovery: CaptureGapRecovery,
  ): Promise<void> {
    const observedAt = this.now();
    return this.onCoverageGap(
      eventEnvelopeSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        eventId: this.makeEventId(),
        source: "service_worker",
        sourceSeq: this.coverageGapSourceSeq++,
        sessionId: root.sessionId,
        scope: { tabId: root.tabId },
        sourceTimestamp: observedAt,
        payload: {
          kind: "capture_gap_close",
          gapId,
          observedEndedAt: observedAt,
          recovery,
        },
      }),
    );
  }

  private rootGapKey(sessionId: SessionId, tabId: ExtTabId): string {
    return JSON.stringify([sessionId, tabId]);
  }

  private childGapKey(
    root: Pick<RootSessionState, "sessionId" | "tabId">,
    targetId: CdpTargetId,
  ): string {
    return JSON.stringify([root.sessionId, root.tabId, targetId]);
  }

  private async enableTarget(target: DebuggerCommandTarget): Promise<void> {
    if (this.durableMessagesSupport === "unknown") {
      try {
        await this.transport.sendCommand(target, "Network.enable", DURABLE_NETWORK_PARAMS);
        this.durableMessagesSupport = "supported";
      } catch {
        this.durableMessagesSupport = "unsupported";
        await this.transport.sendCommand(target, "Network.enable", {});
      }
    } else if (this.durableMessagesSupport === "supported") {
      await this.transport.sendCommand(target, "Network.enable", DURABLE_NETWORK_PARAMS);
    } else {
      await this.transport.sendCommand(target, "Network.enable", {});
    }
    await this.enableTargetDiscovery(target);
    await this.transport.sendCommand(target, "Target.setAutoAttach", AUTO_ATTACH_PARAMS);
  }

  private async enableTargetDiscovery(target: DebuggerCommandTarget): Promise<void> {
    if (target.sessionId !== undefined || this.targetDiscoverySupport === "unsupported") {
      return;
    }
    try {
      await this.transport.sendCommand(target, "Target.setDiscoverTargets", DISCOVER_TARGETS_PARAMS);
      this.targetDiscoverySupport = "supported";
    } catch (cause: unknown) {
      this.targetDiscoverySupport = "unsupported";
      console.warn(
        `[ai-crawler-helper] target discovery unavailable; network recording continues without ` +
          `target-destroyed gap closure: ${describeCause(cause)}`,
      );
    }
  }

  private removeRoot(root: RootSessionState): void {
    root.children.clear();
    const sessionRoots = this.rootsBySession.get(root.sessionId);
    sessionRoots?.delete(root.tabId);
    if (sessionRoots?.size === 0) {
      this.rootsBySession.delete(root.sessionId);
    }
    this.rootsByTab.delete(root.tabId);
  }
}

export const chromeDebuggerSource = (source: unknown): DebuggerCommandTarget | null => {
  const parsed = debuggerSourceSchema.safeParse(source);
  if (!parsed.success || parsed.data.tabId === undefined) {
    return null;
  }
  return parsed.data.sessionId === undefined
    ? { tabId: parsed.data.tabId }
    : { tabId: parsed.data.tabId, sessionId: parsed.data.sessionId };
};
