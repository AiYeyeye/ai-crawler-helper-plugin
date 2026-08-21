import type { ObservationProcessor } from "./observation-processor";
import type { SessionRepository } from "../persistence/session-repository";
import type { NavigationContextRepository } from "../persistence/navigation-context-repository";
import type { SessionRecord, SessionControlRecord } from "../schemas/session";
import type { BrowserContextEvidence } from "../schemas/step";
import type { NavigationSignal, NavigationDecision } from "../core/navigation-coordinator";
import type { SessionTabRecord } from "../schemas/navigation";
import {
  toExtDocumentId,
  toExtFrameId,
  toExtTabId,
  type ExtDocumentId,
  type ExtFrameId,
  type ExtTabId,
  type StepId,
} from "../shared/ids";

export interface BeforeNavigationDetails {
  tabId: number;
  frameId: number;
  url: string;
  timeStamp: number;
  parentFrameId?: number;
}

export interface CommittedNavigationDetails extends BeforeNavigationDetails {
  documentId: string;
  parentDocumentId?: string;
  transitionType: string;
  transitionQualifiers: readonly string[];
  title?: string;
}

export interface CreatedNavigationTargetDetails {
  tabId: number;
  sourceTabId: number;
  sourceFrameId: number;
  url: string;
  timeStamp: number;
}

export interface CreatedTabDetails {
  tabId: number;
  openerTabId?: number;
  createdAt: number;
}

interface ActiveSession {
  session: SessionRecord;
  control: SessionControlRecord;
}

/**
 * chrome.webNavigation / chrome.tabs deliver fractional epoch-ms timestamps,
 * while every persisted epochMs fact requires an integer (epochMsSchema).
 */
const withIntegerTimeStamp = <T extends { timeStamp: number }>(details: T): T => ({
  ...details,
  timeStamp: Math.round(details.timeStamp),
});

interface PendingNavigation {
  sessionId: SessionRecord["sessionId"];
  sourceDocumentId: ExtDocumentId | null;
  beforeUrl: string;
  activeUserStepId: StepId | null;
  sourceStepId: StepId | null;
  contextEvidence?: BrowserContextEvidence;
  redirectChain: Array<{
    fromUrl: string;
    toUrl: string;
    occurredAt: number;
  }>;
  proposedUrl: string;
}

interface NavigationQueueToken {
  readonly key: string;
  readonly admissionId: number;
  readonly frame: FrameGenerationState;
  completion?: Promise<void>;
  sessionGeneration?: NavigationSessionGeneration;
}

interface FrameGenerationState {
  readonly generation: number;
  readonly key: string;
  pendingCount: number;
  canceled: boolean;
}

interface NavigationSessionGeneration {
  readonly sessionId: SessionRecord["sessionId"];
  readonly captureEpochId: SessionControlRecord["captureEpochId"];
  readonly generation: number;
  readonly admitted: Set<Promise<void>>;
  readonly failures: unknown[];
  accepting: boolean;
}

export interface BrowserNavigationProcessorOptions {
  sessions: SessionRepository;
  contexts: NavigationContextRepository;
  getObservationProcessor: (sessionId: SessionRecord["sessionId"]) => ObservationProcessor;
  onDerivedTabRegistered?: (sessionId: SessionRecord["sessionId"], tabId: ExtTabId) => Promise<void>;
  resolveTitle?: (tabId: ExtTabId) => Promise<string | undefined>;
  drainTimeoutMs?: number;
}

/** Chrome event adapter: only registered session tabs cross this boundary. */
export class BrowserNavigationProcessor {
  private readonly sessions: SessionRepository;
  private readonly contexts: NavigationContextRepository;
  private readonly getProcessor: BrowserNavigationProcessorOptions["getObservationProcessor"];
  private readonly onDerivedTabRegistered:
    | BrowserNavigationProcessorOptions["onDerivedTabRegistered"]
    | null;
  private readonly resolveTitle: NonNullable<BrowserNavigationProcessorOptions["resolveTitle"]> | null;
  private readonly drainTimeoutMs: number;
  private readonly pendingByFrame = new Map<string, PendingNavigation>();
  private readonly queueTails = new Map<string, Promise<void>>();
  private readonly frameGenerations = new Map<string, FrameGenerationState>();
  private readonly sessionByFrame = new Map<string, SessionRecord["sessionId"]>();
  private readonly sessionGenerations = new Map<
    SessionRecord["sessionId"],
    NavigationSessionGeneration
  >();
  private readonly unboundAdmissions = new Map<number, Promise<void>>();
  private readonly sealedAdmissionCutoffs = new Map<SessionRecord["sessionId"], number>();
  private nextAdmissionId = 0;
  private nextFrameGeneration = 0;
  private nextSessionGeneration = 0;

  constructor(options: BrowserNavigationProcessorOptions) {
    this.sessions = options.sessions;
    this.contexts = options.contexts;
    this.getProcessor = options.getObservationProcessor;
    this.onDerivedTabRegistered = options.onDerivedTabRegistered ?? null;
    this.resolveTitle = options.resolveTitle ?? null;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 5_000;
    if (!Number.isInteger(this.drainTimeoutMs) || this.drainTimeoutMs <= 0) {
      throw new Error("drainTimeoutMs must be a positive integer");
    }
  }

  handleCreatedNavigationTarget(
    rawDetails: CreatedNavigationTargetDetails,
  ): Promise<boolean> {
    const details = withIntegerTimeStamp(rawDetails);
    return this.enqueueFrame(
      toExtTabId(details.sourceTabId),
      toExtFrameId(details.sourceFrameId),
      false,
      (token) => this.processCreatedNavigationTarget(details, token),
    );
  }

  private async processCreatedNavigationTarget(
    details: CreatedNavigationTargetDetails,
    token: NavigationQueueToken,
  ): Promise<boolean> {
    const active = await this.findActiveSession(toExtTabId(details.sourceTabId), false);
    if (active === null || !this.bindActiveSession(token, active)) {
      return false;
    }
    const sourceFrameId = toExtFrameId(details.sourceFrameId);
    const sourceDocument = await this.contexts.getCurrentDocument(
      active.session.sessionId,
      toExtTabId(details.sourceTabId),
      sourceFrameId,
    );
    if (!this.isCurrent(token)) {
      return false;
    }
    const sourceStepId =
      sourceDocument === null
        ? null
        : await this.getProcessor(active.session.sessionId).activeStepId({
            sessionId: active.session.sessionId,
            captureEpochId: active.control.captureEpochId,
            scope: {
              tabId: sourceDocument.tabId,
              frameId: sourceDocument.frameId,
              documentId: sourceDocument.documentId,
            },
          });
    if (!this.isCurrent(token)) {
      return false;
    }
    await this.contexts.registerDerivedTab({
      sessionId: active.session.sessionId,
      captureEpochId: active.control.captureEpochId,
      tabId: toExtTabId(details.tabId),
      registeredAt: details.timeStamp,
      evidence: {
        evidenceType: "created_navigation_target",
        evidenceId: this.createdTargetEvidenceId(details),
        sourceTabId: toExtTabId(details.sourceTabId),
        sourceFrameId,
        ...(sourceStepId === null ? {} : { sourceStepId }),
      },
    });
    if (!this.isCurrent(token)) {
      return false;
    }
    await this.onDerivedTabRegistered?.(active.session.sessionId, toExtTabId(details.tabId));
    return true;
  }

  handleTabCreated(rawDetails: CreatedTabDetails): Promise<boolean> {
    const details = { ...rawDetails, createdAt: Math.round(rawDetails.createdAt) };
    const rawOpenerTabId = details.openerTabId;
    if (rawOpenerTabId === undefined) {
      return Promise.resolve(false);
    }
    const openerTabId = toExtTabId(rawOpenerTabId);
    return this.enqueueFrame(openerTabId, toExtFrameId(0), false, (token) =>
      this.processTabCreated(
        { ...details, openerTabId: rawOpenerTabId },
        openerTabId,
        token,
      ),
    );
  }

  private async processTabCreated(
    details: CreatedTabDetails & { openerTabId: number },
    openerTabId: ExtTabId,
    token: NavigationQueueToken,
  ): Promise<boolean> {
    const active = await this.findActiveSession(openerTabId, false);
    if (active === null || !this.bindActiveSession(token, active)) {
      return false;
    }
    const existing = await this.contexts.getTab(active.session.sessionId, toExtTabId(details.tabId));
    if (!this.isCurrent(token)) {
      return false;
    }
    if (existing !== null) {
      await this.onDerivedTabRegistered?.(active.session.sessionId, toExtTabId(details.tabId));
      return true;
    }
    const sourceDocument = await this.contexts.getCurrentDocument(
      active.session.sessionId,
      openerTabId,
      toExtFrameId(0),
    );
    if (!this.isCurrent(token)) {
      return false;
    }
    const sourceStepId =
      sourceDocument === null
        ? null
        : await this.getProcessor(active.session.sessionId).activeStepId({
            sessionId: active.session.sessionId,
            captureEpochId: active.control.captureEpochId,
            scope: {
              tabId: openerTabId,
              frameId: sourceDocument.frameId,
              documentId: sourceDocument.documentId,
            },
          });
    if (!this.isCurrent(token)) {
      return false;
    }
    await this.contexts.registerDerivedTab({
      sessionId: active.session.sessionId,
      captureEpochId: active.control.captureEpochId,
      tabId: toExtTabId(details.tabId),
      registeredAt: details.createdAt,
      evidence: {
        evidenceType: "opener_tab_id",
        evidenceId: `opener:${String(details.openerTabId)}:${String(details.tabId)}`,
        sourceTabId: openerTabId,
        ...(sourceStepId === null ? {} : { sourceStepId }),
      },
    });
    if (!this.isCurrent(token)) {
      return false;
    }
    await this.onDerivedTabRegistered?.(active.session.sessionId, toExtTabId(details.tabId));
    return true;
  }

  handleBeforeNavigate(rawDetails: BeforeNavigationDetails): Promise<void> {
    const details = withIntegerTimeStamp(rawDetails);
    const tabId = toExtTabId(details.tabId);
    const frameId = toExtFrameId(details.frameId);
    return this.enqueueFrame(tabId, frameId, undefined, (token) =>
      this.processBeforeNavigate(details, token),
    );
  }

  private async processBeforeNavigate(
    details: BeforeNavigationDetails,
    token: NavigationQueueToken,
  ): Promise<void> {
    const tabId = toExtTabId(details.tabId);
    const frameId = toExtFrameId(details.frameId);
    const active = await this.findActiveSession(tabId, true);
    if (active === null || !this.bindActiveSession(token, active)) {
      return;
    }
    const current = await this.contexts.getCurrentDocument(
      active.session.sessionId,
      tabId,
      frameId,
    );
    if (!this.isCurrent(token)) {
      return;
    }
    const key = token.key;
    const existing = this.pendingByFrame.get(key);
    if (existing !== undefined && existing.sessionId === active.session.sessionId) {
      if (existing.proposedUrl !== details.url) {
        existing.redirectChain.push({
          fromUrl: existing.proposedUrl,
          toUrl: details.url,
          occurredAt: details.timeStamp,
        });
        existing.proposedUrl = details.url;
      }
      return;
    }
    const processor = this.getProcessor(active.session.sessionId);
    const targetContext =
      current === null
        ? null
        : {
            sessionId: active.session.sessionId,
            captureEpochId: active.control.captureEpochId,
            scope: { tabId, frameId, documentId: current.documentId },
          };
    const activeUserStepId =
      targetContext === null ? null : await processor.activeUserStepId(targetContext);
    let sourceStepId =
      targetContext === null ? null : await processor.activeStepId(targetContext);
    let contextEvidence: BrowserContextEvidence | undefined;
    if (
      details.parentFrameId !== undefined &&
      details.parentFrameId >= 0 &&
      details.parentFrameId !== details.frameId
    ) {
      const parentFrameId = toExtFrameId(details.parentFrameId);
      const parentDocument = await this.contexts.getCurrentDocument(
        active.session.sessionId,
        tabId,
        parentFrameId,
      );
      if (parentDocument !== null) {
        const parentStepId = await processor.activeStepId({
          sessionId: active.session.sessionId,
          captureEpochId: active.control.captureEpochId,
          scope: {
            tabId,
            frameId: parentFrameId,
            documentId: parentDocument.documentId,
          },
        });
        if (parentStepId !== null) {
          sourceStepId = parentStepId;
          contextEvidence = {
            evidenceType: "parent_frame_navigation",
            evidenceId: `parent-frame:${String(details.tabId)}:${String(details.parentFrameId)}:${String(details.frameId)}:${String(details.timeStamp)}`,
            sourceStepId: parentStepId,
          };
        }
      }
    }
    if (!this.isCurrent(token)) {
      return;
    }
    this.pendingByFrame.set(key, {
      sessionId: active.session.sessionId,
      sourceDocumentId: current?.documentId ?? null,
      beforeUrl: current?.url ?? "about:blank",
      activeUserStepId: contextEvidence === undefined ? activeUserStepId : null,
      sourceStepId,
      ...(contextEvidence === undefined ? {} : { contextEvidence }),
      redirectChain: [],
      proposedUrl: details.url,
    });
  }

  handleCommitted(details: CommittedNavigationDetails): Promise<NavigationDecision | null> {
    return this.enqueueFrame(
      toExtTabId(details.tabId),
      toExtFrameId(details.frameId),
      null,
      (token) => this.recordCommitted(details, this.webNavigationSignal(details), token),
    );
  }

  handleHashChange(details: CommittedNavigationDetails): Promise<NavigationDecision | null> {
    return this.enqueueFrame(
      toExtTabId(details.tabId),
      toExtFrameId(details.frameId),
      null,
      (token) =>
        this.recordCommitted(details, { kind: "history", action: "hash_change" }, token),
    );
  }

  private async recordCommitted(
    rawDetails: CommittedNavigationDetails,
    signal: NavigationSignal,
    token: NavigationQueueToken,
  ): Promise<NavigationDecision | null> {
    const details = withIntegerTimeStamp(rawDetails);
    const tabId = toExtTabId(details.tabId);
    const frameId = toExtFrameId(details.frameId);
    const afterDocumentId = toExtDocumentId(details.documentId);
    const active = await this.findActiveSession(tabId, true);
    if (active === null || !this.bindActiveSession(token, active)) {
      return null;
    }
    const tab = await this.contexts.getTab(active.session.sessionId, tabId);
    if (tab === null || !this.isCurrent(token)) {
      return null;
    }
    const current = await this.contexts.getCurrentDocument(
      active.session.sessionId,
      tabId,
      frameId,
    );
    if (!this.isCurrent(token)) {
      return null;
    }
    const resolvedTitle =
      details.title ??
      (frameId === 0 && this.resolveTitle !== null
        ? await this.resolveTitle(tabId)
        : undefined);
    if (!this.isCurrent(token)) {
      return null;
    }
    if (signal.kind === "history" && current?.url === details.url) {
      this.pendingByFrame.delete(token.key);
      return null;
    }
    const pendingKey = token.key;
    const pending = this.pendingByFrame.get(pendingKey);
    const beforeDocumentId = pending?.sourceDocumentId ?? current?.documentId ?? afterDocumentId;
    const beforeUrl =
      pending?.beforeUrl ??
      current?.url ??
      (tab.kind === "derived" ? "about:blank" : active.session.originUrl);
    const redirectChain = [...(pending?.redirectChain ?? [])];
    if (
      signal.kind === "web_navigation" &&
      signal.navigationType === "redirect" &&
      beforeUrl !== details.url &&
      !redirectChain.some((hop) => hop.toUrl === details.url)
    ) {
      redirectChain.push({
        fromUrl: redirectChain.at(-1)?.toUrl ?? beforeUrl,
        toUrl: details.url,
        occurredAt: details.timeStamp,
      });
    }
    const evidence =
      pending?.contextEvidence === undefined
        ? this.tabEvidence(tab, pending?.sourceStepId ?? null)
        : [pending.contextEvidence];
    if (!this.isCurrent(token)) {
      return null;
    }
    const decision = await this.getProcessor(active.session.sessionId).recordNavigation(
      {
        sessionId: active.session.sessionId,
        captureEpochId: active.control.captureEpochId,
        scope: { tabId, frameId, documentId: beforeDocumentId },
        beforeUrl,
        afterUrl: details.url,
        afterDocumentId,
        ...(resolvedTitle === undefined ? {} : { title: resolvedTitle }),
        signal:
          signal.kind === "web_navigation"
            ? { ...signal, redirectChain }
            : signal,
        committedAt: details.timeStamp,
        ...(pending?.activeUserStepId === null || pending?.activeUserStepId === undefined
          ? {}
          : { activeUserStepId: pending.activeUserStepId }),
      },
      evidence,
    );
    if (!this.isCurrent(token)) {
      return null;
    }
    await this.contexts.upsertDocument({
      sessionId: active.session.sessionId,
      captureEpochId: active.control.captureEpochId,
      tabId,
      frameId,
      documentId: afterDocumentId,
      ...(details.parentDocumentId === undefined
        ? {}
        : { parentDocumentId: toExtDocumentId(details.parentDocumentId) }),
      url: details.url,
      ...(resolvedTitle === undefined ? {} : { title: resolvedTitle }),
      committedAt: details.timeStamp,
    });
    this.pendingByFrame.delete(pendingKey);
    return decision;
  }

  private async findActiveSession(
    tabId: ExtTabId,
    allowStopping: boolean,
  ): Promise<ActiveSession | null> {
    const candidates = (await this.sessions.listSessionsForTab(tabId))
      .filter(
        (session) =>
          session.lifecycle === "recording" ||
          (allowStopping && session.lifecycle === "stopping"),
      )
      .sort((left, right) => right.startedAt - left.startedAt);
    for (const session of candidates) {
      const control = await this.sessions.getControl(session.sessionId);
      if (
        control !== null &&
        (control.lifecycle === "recording" ||
          (allowStopping && control.lifecycle === "stopping"))
      ) {
        return { session, control };
      }
    }
    return null;
  }

  private tabEvidence(
    tab: SessionTabRecord,
    fallbackSourceStepId: StepId | null,
  ): BrowserContextEvidence[] | undefined {
    if (tab.kind === "root") {
      return undefined;
    }
    const sourceStepId = tab.evidence.sourceStepId ?? fallbackSourceStepId ?? undefined;
    if (sourceStepId === undefined) {
      return [];
    }
    return [
      {
        evidenceType: tab.evidence.evidenceType,
        evidenceId: tab.evidence.evidenceId,
        sourceStepId,
      },
    ];
  }

  private webNavigationSignal(details: CommittedNavigationDetails): NavigationSignal {
    const qualifiers = new Set(details.transitionQualifiers);
    const navigationType = qualifiers.has("forward_back")
      ? "back_forward"
      : qualifiers.has("client_redirect") || qualifiers.has("server_redirect")
        ? "redirect"
        : details.transitionType === "reload"
          ? "reload"
          : details.transitionType === "form_submit"
            ? "form_submit"
            : details.transitionType === "link"
              ? "link"
              : "other";
    return { kind: "web_navigation", navigationType };
  }

  private frameKey(tabId: ExtTabId, frameId: ExtFrameId): string {
    return JSON.stringify([tabId, frameId]);
  }

  private enqueueFrame<T>(
    tabId: ExtTabId,
    frameId: ExtFrameId,
    canceledValue: T,
    operation: (token: NavigationQueueToken) => Promise<T>,
  ): Promise<T> {
    const key = this.frameKey(tabId, frameId);
    let frame = this.frameGenerations.get(key);
    if (frame === undefined || frame.canceled) {
      frame = {
        generation: this.nextFrameGeneration++,
        key,
        pendingCount: 0,
        canceled: false,
      };
      this.frameGenerations.set(key, frame);
    }
    frame.pendingCount += 1;
    const token: NavigationQueueToken = {
      key,
      admissionId: this.nextAdmissionId++,
      frame,
    };
    const previous = this.queueTails.get(key) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() =>
      this.isCurrent(token) ? operation(token) : Promise.resolve(canceledValue),
    );
    const releaseQueue = (failure?: unknown): void => {
      if (failure !== undefined) {
        token.sessionGeneration?.failures.push(failure);
      }
      this.unboundAdmissions.delete(token.admissionId);
      if (token.completion !== undefined) {
        token.sessionGeneration?.admitted.delete(token.completion);
      }
      frame.pendingCount -= 1;
      if (this.queueTails.get(key) === token.completion) {
        this.queueTails.delete(key);
      }
      this.cleanupFrame(frame);
    };
    const completion = task.then(
      () => { releaseQueue(); },
      (cause: unknown) => { releaseQueue(cause); },
    );
    token.completion = completion;
    this.unboundAdmissions.set(token.admissionId, completion);
    this.queueTails.set(key, completion);
    return task;
  }

  private isCurrent(token: NavigationQueueToken): boolean {
    if (this.frameGenerations.get(token.key) !== token.frame || token.frame.canceled) {
      return false;
    }
    const sessionGeneration = token.sessionGeneration;
    return (
      sessionGeneration === undefined ||
      (sessionGeneration.accepting &&
        this.sessionGenerations.get(sessionGeneration.sessionId) === sessionGeneration)
    );
  }

  private bindActiveSession(token: NavigationQueueToken, active: ActiveSession): boolean {
    if (!this.isCurrent(token)) {
      return false;
    }
    const sessionId = active.session.sessionId;
    const cutoff = this.sealedAdmissionCutoffs.get(sessionId) ?? -1;
    if (token.admissionId <= cutoff) {
      return false;
    }
    let generation = this.sessionGenerations.get(sessionId);
    if (
      generation === undefined ||
      !generation.accepting ||
      generation.captureEpochId !== active.control.captureEpochId
    ) {
      generation = {
        sessionId,
        captureEpochId: active.control.captureEpochId,
        generation: this.nextSessionGeneration++,
        admitted: new Set(),
        failures: [],
        accepting: true,
      };
      this.sessionGenerations.set(sessionId, generation);
    }
    token.sessionGeneration = generation;
    this.sessionByFrame.set(token.key, sessionId);
    this.unboundAdmissions.delete(token.admissionId);
    if (token.completion !== undefined) {
      generation.admitted.add(token.completion);
    }
    return this.isCurrent(token);
  }

  private cleanupFrame(frame: FrameGenerationState): void {
    if (
      frame.pendingCount === 0 &&
      !this.pendingByFrame.has(frame.key) &&
      this.frameGenerations.get(frame.key) === frame
    ) {
      this.frameGenerations.delete(frame.key);
      this.sessionByFrame.delete(frame.key);
    }
  }

  private cancelFrame(key: string): void {
    const frame = this.frameGenerations.get(key);
    if (frame !== undefined) {
      frame.canceled = true;
      if (this.frameGenerations.get(key) === frame) {
        this.frameGenerations.delete(key);
      }
    }
    this.queueTails.delete(key);
    this.pendingByFrame.delete(key);
    this.sessionByFrame.delete(key);
  }

  private createdTargetEvidenceId(details: CreatedNavigationTargetDetails): string {
    return `created-target:${String(details.sourceTabId)}:${String(details.sourceFrameId)}:${String(details.tabId)}:${String(details.timeStamp)}`;
  }

  async sealAndDrain(sessionId: SessionRecord["sessionId"]): Promise<void> {
    const cutoff = this.nextAdmissionId - 1;
    this.sealedAdmissionCutoffs.set(
      sessionId,
      Math.max(this.sealedAdmissionCutoffs.get(sessionId) ?? -1, cutoff),
    );
    const generation = this.sessionGenerations.get(sessionId);
    if (generation !== undefined) {
      generation.accepting = false;
    }
    const admitted = [
      ...(generation?.admitted ?? []),
      ...[...this.unboundAdmissions.entries()]
        .filter(([admissionId]) => admissionId <= cutoff)
        .map(([, completion]) => completion),
    ];
    const failures: unknown[] = [];
    try {
      await this.withDrainDeadline(
        Promise.allSettled(admitted).then(() => undefined),
        sessionId,
      );
    } catch (cause: unknown) {
      failures.push(cause);
    }
    failures.push(...(generation?.failures ?? []));
    const ownedKeys = new Set<string>();
    for (const [key, ownerSessionId] of this.sessionByFrame) {
      if (ownerSessionId === sessionId) {
        ownedKeys.add(key);
      }
    }
    for (const [key, pending] of this.pendingByFrame) {
      if (pending.sessionId === sessionId) {
        ownedKeys.add(key);
      }
    }
    for (const key of ownedKeys) {
      this.cancelFrame(key);
    }
    if (generation !== undefined && this.sessionGenerations.get(sessionId) === generation) {
      this.sessionGenerations.delete(sessionId);
    }
    this.throwFailures("navigation queue drain failed", failures);
  }

  forgetSession(sessionId: SessionRecord["sessionId"]): Promise<void> {
    return this.sealAndDrain(sessionId);
  }

  handleNavigationError(tabId: number, frameId: number): void {
    this.cancelFrame(this.frameKey(toExtTabId(tabId), toExtFrameId(frameId)));
  }

  private withDrainDeadline(promise: Promise<void>, sessionId: SessionRecord["sessionId"]): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(
          new Error(
            `navigation session ${sessionId} drain timed out after ${String(this.drainTimeoutMs)}ms`,
          ),
        );
      }, this.drainTimeoutMs);
    });
    return Promise.race([promise, deadline]).finally(() => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    });
  }

  private throwFailures(message: string, failures: readonly unknown[]): void {
    if (failures.length === 0) {
      return;
    }
    if (failures.length === 1 && failures[0] instanceof Error) {
      throw failures[0];
    }
    throw new AggregateError(failures, message);
  }
}
