import { z } from "zod";
import {
  NetworkEventAssembler,
  classifyResponseBody,
  type NetworkRequestStartContext,
  type RequestWillBeSentInput,
} from "../core/network-event-assembler";
import type { StepContext } from "../core/step-orchestrator";
import {
  NETWORK_PENDING_EVENT_DEADLINE_MS,
  NETWORK_PENDING_EVENT_MAX_BYTES,
  NETWORK_PENDING_EVENT_MAX_COUNT,
} from "../core/config";
import { SCHEMA_VERSION } from "../schemas/common";
import {
  captureGapRecordSchema,
  type CaptureGapReason,
} from "../schemas/capture-gap";
import { eventEnvelopeSchema, type EnvelopeAck, type EventEnvelope } from "../schemas/event-envelope";
import {
  buildRequestKey,
  networkStreamMessageRecordSchema,
  requestRecordSchema,
  type IdentifierMapping,
  type RequestRecord,
} from "../schemas/network";
import type { SessionConfig } from "../schemas/session";
import {
  cdpFrameIdSchema,
  cdpLoaderIdSchema,
  cdpRequestIdSchema,
  newGapId,
  type AttachEpoch,
  type CdpRequestId,
  type CdpSessionId,
  type EventId,
  type ExtTabId,
  type SessionId,
  type StepId,
  type GapId,
} from "../shared/ids";
import type { DebuggerCommandTarget, DebuggerTransport } from "./debugger-session-manager";
import { utf8ByteLength } from "../shared/json-bytes";

const headerValueSchema = z.union([z.string(), z.number()]);
const headersSchema = z.record(headerValueSchema);

const requestWillBeSentSchema = z
  .object({
    requestId: cdpRequestIdSchema,
    timestamp: z.number().nonnegative(),
    wallTime: z.number().nonnegative(),
    type: z.string().optional(),
    frameId: cdpFrameIdSchema.optional(),
    loaderId: cdpLoaderIdSchema.optional(),
    initiator: z
      .object({ type: z.string(), requestId: cdpRequestIdSchema.optional() })
      .passthrough()
      .optional(),
    request: z
      .object({
        url: z.string(),
        method: z.string(),
        headers: headersSchema,
        postData: z.string().optional(),
      })
      .passthrough(),
    redirectResponse: z
      .object({
        status: z.number(),
        headers: headersSchema,
        mimeType: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const requestExtraInfoSchema = z
  .object({ requestId: cdpRequestIdSchema, headers: headersSchema })
  .passthrough();

const responseExtraInfoSchema = z
  .object({
    requestId: cdpRequestIdSchema,
    statusCode: z.number().int(),
    headers: headersSchema,
  })
  .passthrough();

const responseReceivedSchema = z
  .object({
    requestId: cdpRequestIdSchema,
    timestamp: z.number().nonnegative(),
    response: z
      .object({
        status: z.number(),
        headers: headersSchema,
        mimeType: z.string().optional(),
      })
      .passthrough(),
    hasExtraInfo: z.boolean().optional(),
  })
  .passthrough();

const loadingFinishedSchema = z
  .object({
    requestId: cdpRequestIdSchema,
    timestamp: z.number().nonnegative(),
    encodedDataLength: z.number().finite(),
  })
  .passthrough();

const loadingFailedSchema = z
  .object({
    requestId: cdpRequestIdSchema,
    timestamp: z.number().nonnegative(),
    errorText: z.string(),
    canceled: z.boolean().optional(),
  })
  .passthrough();

const webSocketFrameSchema = z
  .object({
    requestId: cdpRequestIdSchema,
    timestamp: z.number().nonnegative(),
    response: z
      .object({
        opcode: z.number().int().nonnegative(),
        mask: z.boolean(),
        payloadData: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

const webSocketCreatedSchema = z
  .object({
    requestId: cdpRequestIdSchema,
    url: z.string(),
    initiator: z.object({ type: z.string() }).passthrough().optional(),
  })
  .passthrough();

const webSocketHandshakeRequestSchema = z
  .object({
    requestId: cdpRequestIdSchema,
    timestamp: z.number().nonnegative(),
    wallTime: z.number().nonnegative(),
    request: z.object({ headers: headersSchema }).passthrough(),
  })
  .passthrough();

const webSocketHandshakeResponseSchema = z
  .object({
    requestId: cdpRequestIdSchema,
    timestamp: z.number().nonnegative(),
    response: z.object({ status: z.number(), headers: headersSchema }).passthrough(),
  })
  .passthrough();

const webSocketClosedSchema = z
  .object({ requestId: cdpRequestIdSchema, timestamp: z.number().nonnegative() })
  .passthrough();

const webSocketFrameErrorSchema = z
  .object({
    requestId: cdpRequestIdSchema,
    timestamp: z.number().nonnegative(),
    errorMessage: z.string(),
  })
  .passthrough();

const eventSourceMessageSchema = z
  .object({
    requestId: cdpRequestIdSchema,
    timestamp: z.number().nonnegative(),
    eventName: z.string(),
    eventId: z.string(),
    data: z.string(),
  })
  .passthrough();

const responseBodyReplySchema = z
  .object({ body: z.string(), base64Encoded: z.boolean() })
  .strict();

const requestIdOnlySchema = z.object({ requestId: cdpRequestIdSchema }).passthrough();

interface PendingNetworkEvent {
  source: DebuggerCommandTarget;
  method: string;
  rawParams: unknown;
  admission?: NetworkEventAdmission;
}

/**
 * Which admission path buffered a pending request chain:
 * - `missing_clock`: events arrived before Network.requestWillBeSent (in-flight
 *   before attach); the request start will never be observed.
 * - `scope_pending`: the start arrived and the clock is set, but the request
 *   scope (document context) did not resolve within the deadline.
 */
type PendingBufferPath = "missing_clock" | "scope_pending";

interface GapPersistenceState {
  tail: Promise<void>;
  readonly failures: unknown[];
}

interface ActiveReplayBatch {
  readonly sourceKey: string;
  readonly chainKey: string;
  readonly path: PendingBufferPath;
  remaining: number;
  invalidated: boolean;
  accounted: boolean;
}

interface WebSocketCreatedState {
  url: string;
  initiatorType?: string;
}

export interface DebuggerCaptureContext {
  sessionId: SessionId;
  tabId: ExtTabId;
  attachEpoch: AttachEpoch;
  childSessionId?: CdpSessionId;
}

export interface NetworkEventAdmission {
  readonly context: DebuggerCaptureContext;
  readonly signal?: AbortSignal;
}

export interface ResolvedNetworkRequestContext {
  stepContext: StepContext;
  identifierMapping: IdentifierMapping;
}

export interface NetworkStepProcessor {
  recordNetworkRequestStarted(
    context: StepContext,
    requestKey: string,
    observedAt: number,
  ): Promise<{ startedInStepId: StepId }>;
  recordNetworkRequestFinished(
    sessionId: SessionId,
    requestKey: string,
  ): Promise<{ startedInStepId: StepId } | null>;
  recordNetworkMessageObserved(
    context: StepContext,
    observedAt: number,
  ): Promise<{ observedDuringStepId: StepId }>;
}

interface EnvelopeIngestor {
  ingest(envelope: EventEnvelope): Promise<EnvelopeAck>;
}

export interface NetworkCaptureControllerOptions {
  ingestor: EnvelopeIngestor;
  transport: DebuggerTransport;
  resolveDebuggerContext: (source: DebuggerCommandTarget) => DebuggerCaptureContext | null;
  resolveRequestContext: (
    debuggerContext: DebuggerCaptureContext,
    input: { url: string; frameId?: string; loaderId?: string },
  ) => Promise<ResolvedNetworkRequestContext | null>;
  processorForSession: (sessionId: SessionId) => NetworkStepProcessor;
  sessionConfigFor: (sessionId: SessionId) => Promise<SessionConfig>;
  newEventId: () => EventId;
  newGapId?: () => GapId;
  now?: () => number;
  classifyOrphanNetworkEvent?: (
    sourceKey: string,
    method: string,
    requestId: CdpRequestId,
  ) => "explained" | "unexplained";
  orphanGapWindowMs?: number;
  pendingEventMaxCount?: number;
  pendingEventMaxBytes?: number;
  pendingEventDeadlineMs?: number;
}

/** Routes validated raw CDP Network events into Step attribution + durable facts. */
export class NetworkCaptureController {
  private readonly ingestor: EnvelopeIngestor;
  private readonly transport: DebuggerTransport;
  private readonly resolveDebuggerContext: NetworkCaptureControllerOptions["resolveDebuggerContext"];
  private readonly resolveRequestContext: NetworkCaptureControllerOptions["resolveRequestContext"];
  private readonly processorForSession: NetworkCaptureControllerOptions["processorForSession"];
  private readonly sessionConfigFor: NetworkCaptureControllerOptions["sessionConfigFor"];
  private readonly makeEventId: () => EventId;
  private readonly makeGapId: () => GapId;
  private readonly now: () => number;
  private readonly assemblers = new Map<string, NetworkEventAssembler>();
  private readonly sessionBySourceKey = new Map<string, SessionId>();
  private readonly contextBySourceKey = new Map<string, DebuggerCaptureContext>();
  private readonly clockOffsetMs = new Map<string, number>();
  private readonly hopByRequest = new Map<string, number>();
  private readonly sourceSeq = new Map<string, number>();
  private readonly pendingEvents = new Map<string, PendingNetworkEvent[]>();
  private readonly pendingEventBytes = new Map<string, number>();
  private readonly replayingPendingKeys = new Set<string>();
  private readonly webSockets = new Map<string, WebSocketCreatedState>();
  private readonly releasedStepRequests = new Set<string>();
  private readonly releasedStepRequestSessions = new Map<string, SessionId>();
  private readonly overflowedPendingKeys = new Set<string>();
  private readonly unavailableWebSocketKeys = new Set<string>();
  private readonly orphanedNetworkEvents = new Map<string, number>();
  private readonly classifyOrphan: NetworkCaptureControllerOptions["classifyOrphanNetworkEvent"];
  private readonly orphanGapWindowMs: number;
  private readonly pendingEventMaxCount: number;
  private readonly pendingEventMaxBytes: number;
  private readonly pendingEventDeadlineMs: number;
  private readonly pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingMeta = new Map<string, { context: DebuggerCaptureContext; sourceKey: string }>();
  private readonly lastUnrecoverableGapAtMs = new Map<string, number>();
  private readonly missingClockEvents = new Map<string, PendingNetworkEvent[]>();
  private readonly gapPersistenceBySourceKey = new Map<string, GapPersistenceState>();
  private readonly failedSourceKeys = new Set<string>();
  private readonly activeRequestStartsBySourceKey = new Map<string, number>();
  private readonly activeReplayBatchesBySourceKey = new Map<string, Set<ActiveReplayBatch>>();

  constructor(options: NetworkCaptureControllerOptions) {
    this.ingestor = options.ingestor;
    this.transport = options.transport;
    this.resolveDebuggerContext = options.resolveDebuggerContext;
    this.resolveRequestContext = options.resolveRequestContext;
    this.processorForSession = options.processorForSession;
    this.sessionConfigFor = options.sessionConfigFor;
    this.makeEventId = options.newEventId;
    this.makeGapId = options.newGapId ?? newGapId;
    this.now = options.now ?? (() => Date.now());
    this.classifyOrphan = options.classifyOrphanNetworkEvent;
    this.orphanGapWindowMs = options.orphanGapWindowMs ?? 0;
    this.pendingEventMaxCount = options.pendingEventMaxCount ?? NETWORK_PENDING_EVENT_MAX_COUNT;
    this.pendingEventMaxBytes = options.pendingEventMaxBytes ?? NETWORK_PENDING_EVENT_MAX_BYTES;
    this.pendingEventDeadlineMs =
      options.pendingEventDeadlineMs ?? NETWORK_PENDING_EVENT_DEADLINE_MS;
  }

  restoreInFlightRequests(
    context: DebuggerCaptureContext,
    records: readonly RequestRecord[],
  ): void {
    const sourceKey = this.sourceKey(context);
    const assembler = this.assembler(sourceKey);
    const offsets = new Set<number>();
    for (const rawRecord of records) {
      const record = requestRecordSchema.parse(rawRecord);
      if (
        record.sessionId !== context.sessionId ||
        record.keyParts.tabId !== context.tabId ||
        record.keyParts.attachEpoch !== context.attachEpoch ||
        record.keyParts.childSessionId !== context.childSessionId ||
        record.completedAt !== undefined ||
        record.failure !== undefined
      ) {
        continue;
      }
      assembler.restoreRequest(record);
      const chainKey = this.chainKey(sourceKey, record.keyParts.requestId);
      const currentHop = this.hopByRequest.get(chainKey) ?? -1;
      this.hopByRequest.set(chainKey, Math.max(currentHop, record.keyParts.redirectHop));
      if (record.cdpClockOffsetMs !== undefined) {
        offsets.add(record.cdpClockOffsetMs);
      }
    }
    if (offsets.size > 1) {
      throw new Error(`conflicting CDP clock offsets for ${sourceKey}`);
    }
    const offset = [...offsets][0];
    if (offset !== undefined) {
      this.clockOffsetMs.set(sourceKey, offset);
    }
  }

  async forgetSession(sessionId: SessionId): Promise<void> {
    const sourceKeys = new Set<string>();
    for (const [sourceKey, ownerSessionId] of this.sessionBySourceKey) {
      if (ownerSessionId === sessionId) {
        sourceKeys.add(sourceKey);
        this.sessionBySourceKey.delete(sourceKey);
        this.contextBySourceKey.delete(sourceKey);
      }
    }
    try {
      await this.forgetSourceKeys(sourceKeys);
    } finally {
      for (const [requestKey, ownerSessionId] of this.releasedStepRequestSessions) {
        if (ownerSessionId === sessionId) {
          this.releasedStepRequestSessions.delete(requestKey);
          this.releasedStepRequests.delete(requestKey);
        }
      }
    }
  }

  async forgetCaptureRoot(context: DebuggerCaptureContext): Promise<void> {
    const sourceKeys = new Set<string>();
    for (const [sourceKey, sourceContext] of this.contextBySourceKey) {
      if (
        sourceContext.sessionId === context.sessionId &&
        sourceContext.tabId === context.tabId &&
        sourceContext.attachEpoch === context.attachEpoch
      ) {
        sourceKeys.add(sourceKey);
        this.contextBySourceKey.delete(sourceKey);
        this.sessionBySourceKey.delete(sourceKey);
      }
    }
    await this.forgetSourceKeys(sourceKeys);
  }

  private async forgetSourceKeys(sourceKeys: ReadonlySet<string>): Promise<void> {
    for (const sourceKey of sourceKeys) {
      this.assemblers.delete(sourceKey);
      this.clockOffsetMs.delete(sourceKey);
      this.sourceSeq.delete(sourceKey);
      this.failedSourceKeys.delete(sourceKey);
      this.activeRequestStartsBySourceKey.delete(sourceKey);
      const activeBatches = this.activeReplayBatchesBySourceKey.get(sourceKey);
      if (activeBatches !== undefined) {
        for (const batch of activeBatches) {
          batch.invalidated = true;
          batch.remaining = 0;
        }
        this.activeReplayBatchesBySourceKey.delete(sourceKey);
      }
    }
    const deleteOwnedChainKeys = (collection: Map<string, unknown> | Set<string>): void => {
      for (const key of collection.keys()) {
        if (this.chainKeyBelongsToSources(key, sourceKeys)) {
          collection.delete(key);
        }
      }
    };
    for (const [key, timer] of this.pendingTimers) {
      if (this.chainKeyBelongsToSources(key, sourceKeys)) {
        clearTimeout(timer);
        this.pendingTimers.delete(key);
      }
    }
    deleteOwnedChainKeys(this.hopByRequest);
    deleteOwnedChainKeys(this.pendingEvents);
    deleteOwnedChainKeys(this.pendingEventBytes);
    deleteOwnedChainKeys(this.replayingPendingKeys);
    deleteOwnedChainKeys(this.webSockets);
    deleteOwnedChainKeys(this.overflowedPendingKeys);
    deleteOwnedChainKeys(this.unavailableWebSocketKeys);
    deleteOwnedChainKeys(this.orphanedNetworkEvents);
    deleteOwnedChainKeys(this.pendingMeta);
    deleteOwnedChainKeys(this.lastUnrecoverableGapAtMs);
    deleteOwnedChainKeys(this.missingClockEvents);
    const states = [...sourceKeys]
      .map((sourceKey) => this.gapPersistenceBySourceKey.get(sourceKey))
      .filter((state): state is GapPersistenceState => state !== undefined);
    await Promise.all(states.map((state) => state.tail.catch(() => undefined)));
    for (const sourceKey of sourceKeys) {
      this.gapPersistenceBySourceKey.delete(sourceKey);
    }
    const failure = states.flatMap((state) => state.failures)[0];
    if (failure !== undefined) {
      throw failure instanceof Error
        ? failure
        : new Error("background network CaptureGap persistence failed");
    }
  }

  async handleNetworkEvent(
    source: DebuggerCommandTarget,
    method: string,
    rawParams: unknown,
    admission?: NetworkEventAdmission,
  ): Promise<void> {
    return this.handleNetworkEventOwned(source, method, rawParams, admission);
  }

  private async handleNetworkEventOwned(
    source: DebuggerCommandTarget,
    method: string,
    rawParams: unknown,
    admission?: NetworkEventAdmission,
    replayOwner?: ActiveReplayBatch,
  ): Promise<void> {
    const isCanceled = (): boolean => admission?.signal?.aborted ?? false;
    if (isCanceled()) {
      return;
    }
    const debuggerContext = admission?.context ?? this.resolveDebuggerContext(source);
    if (debuggerContext === null || isCanceled()) {
      return;
    }
    const sourceKey = this.sourceKey(debuggerContext);
    if (this.failedSourceKeys.has(sourceKey)) {
      return;
    }
    const assembler = this.assembler(sourceKey);
    const requestIdentity = requestIdOnlySchema.safeParse(rawParams);
    const pendingKey = requestIdentity.success
      ? this.chainKey(sourceKey, requestIdentity.data.requestId)
      : null;
    if (
      pendingKey !== null &&
      this.overflowedPendingKeys.has(pendingKey)
    ) {
      return;
    }
    if (
      pendingKey !== null &&
      this.pendingEvents.has(pendingKey) &&
      !this.replayingPendingKeys.has(pendingKey)
    ) {
      const bufferedCount =
        (this.pendingEvents.get(pendingKey)?.length ?? 0) +
        (this.missingClockEvents.get(pendingKey)?.length ?? 0);
      const path = this.pendingPathOf(pendingKey);
      if (!this.enqueuePending(pendingKey, {
        source,
        method,
        rawParams,
        ...(admission === undefined ? {} : { admission }),
      }, debuggerContext, sourceKey)) {
        await this.persistBufferOverflowGap(
          debuggerContext,
          sourceKey,
          pendingKey,
          bufferedCount + 1,
          path,
        );
        return;
      }
      await this.replayPending(pendingKey, sourceKey, debuggerContext);
      return;
    }
    switch (method) {
      case "Network.requestWillBeSent": {
        const ownsActiveStart = this.beginDirectRequestStart(sourceKey, replayOwner);
        let activeStartFinished = false;
        let assignedRequest:
          | { readonly processor: NetworkStepProcessor; readonly requestKey: string }
          | undefined;
        let completedRedirectToRelease: RequestRecord | undefined;
        let completedRedirectReleased = false;
        let requestStartEstablished = false;
        try {
          const params = requestWillBeSentSchema.parse(rawParams);
          this.clockOffsetMs.set(
            sourceKey,
            params.wallTime * 1_000 - params.timestamp * 1_000,
          );
          const timestampMs = this.toEpochMs(sourceKey, params.timestamp);
          const requestScope = await this.resolveRequestContext(debuggerContext, {
            url: params.request.url,
            ...(params.frameId === undefined ? {} : { frameId: params.frameId }),
            ...(params.loaderId === undefined ? {} : { loaderId: params.loaderId }),
          });
          if (this.isSourceStopped(sourceKey, isCanceled)) {
            return;
          }
          if (requestScope === null) {
            const key = this.chainKey(sourceKey, params.requestId);
            const bufferedCount =
              (this.pendingEvents.get(key)?.length ?? 0) +
              (this.missingClockEvents.get(key)?.length ?? 0);
            const path = this.pendingPathOf(key);
            if (!this.enqueuePending(key, {
              source,
              method,
              rawParams,
              ...(admission === undefined ? {} : { admission }),
            }, debuggerContext, sourceKey)) {
              // The B1 overflow gap now owns this request start. Stop exposing
              // it to B2 accounting before awaiting the gap ACK, otherwise a
              // concurrent child-source failure can count the same event twice.
              if (ownsActiveStart) {
                this.finishDirectRequestStart(sourceKey);
                activeStartFinished = true;
              }
              await this.persistBufferOverflowGap(
                debuggerContext,
                sourceKey,
                key,
                bufferedCount + 1,
                path,
              );
            }
            return;
          }
          const chainKey = this.chainKey(sourceKey, params.requestId);
          const previousHop = this.hopByRequest.get(chainKey);
          const redirectHop =
            params.redirectResponse === undefined ? (previousHop ?? 0) : (previousHop ?? 0) + 1;
          this.hopByRequest.set(chainKey, redirectHop);
          const keyParts = {
            tabId: debuggerContext.tabId,
            ...(debuggerContext.childSessionId === undefined
              ? {}
              : { childSessionId: debuggerContext.childSessionId }),
            attachEpoch: debuggerContext.attachEpoch,
            requestId: params.requestId,
            redirectHop,
          };
          const requestKey = buildRequestKey(keyParts);
          const processor = this.processorForSession(debuggerContext.sessionId);
          const assignment = await processor.recordNetworkRequestStarted(
            requestScope.stepContext,
            requestKey,
            timestampMs,
          );
          assignedRequest = { processor, requestKey };
          if (this.isSourceStopped(sourceKey, isCanceled)) {
            return;
          }
          const startContext: NetworkRequestStartContext = {
            sessionId: debuggerContext.sessionId,
            captureEpochId: requestScope.stepContext.captureEpochId,
            scope: requestScope.stepContext.scope,
            startedInStepId: assignment.startedInStepId,
            attachEpoch: debuggerContext.attachEpoch,
            ...(debuggerContext.childSessionId === undefined
              ? {}
              : { childSessionId: debuggerContext.childSessionId }),
            identifierMapping: requestScope.identifierMapping,
            cdpClockOffsetMs: this.requireClockOffset(sourceKey),
          };
          const base: RequestWillBeSentInput = {
            context: startContext,
            requestId: params.requestId,
            timestampMs,
            request: {
              url: params.request.url,
              method: params.request.method,
              headers: params.request.headers,
              ...(params.request.postData === undefined
                ? {}
                : { postData: params.request.postData }),
            },
            ...(params.type === undefined ? {} : { resourceType: params.type }),
            ...(params.frameId === undefined ? {} : { cdpFrameId: params.frameId }),
            ...(params.loaderId === undefined ? {} : { loaderId: params.loaderId }),
            ...(params.initiator === undefined
              ? {}
              : {
                  initiator: {
                    type: params.initiator.type,
                    ...(params.initiator.requestId === undefined
                      ? {}
                      : { requestId: params.initiator.requestId }),
                  },
                }),
          };
          if (params.redirectResponse === undefined) {
            const record = assembler.onRequestWillBeSent(base);
            await this.persistMetadata(sourceKey, requestScope.stepContext, timestampMs, record);
            if (this.isSourceStopped(sourceKey, isCanceled)) {
              return;
            }
            requestStartEstablished = true;
          } else {
            const transition = assembler.onRequestWillBeSent({
              ...base,
              redirectResponse: {
                statusCode: params.redirectResponse.status,
                headers: params.redirectResponse.headers,
                ...(params.redirectResponse.mimeType === undefined
                  ? {}
                  : { mimeType: params.redirectResponse.mimeType }),
              },
            });
            completedRedirectToRelease = transition.completedRedirect;
            await this.persistMetadata(
              sourceKey,
              requestScope.stepContext,
              timestampMs,
              transition.completedRedirect,
            );
            if (this.isSourceStopped(sourceKey, isCanceled)) {
              return;
            }
            await processor.recordNetworkRequestFinished(
              debuggerContext.sessionId,
              transition.completedRedirect.requestKey,
            );
            completedRedirectReleased = true;
            if (this.isSourceStopped(sourceKey, isCanceled)) {
              return;
            }
            await this.persistMetadata(
              sourceKey,
              requestScope.stepContext,
              timestampMs,
              transition.started,
            );
            if (this.isSourceStopped(sourceKey, isCanceled)) {
              return;
            }
            requestStartEstablished = true;
          }
          if (ownsActiveStart) {
            this.finishDirectRequestStart(sourceKey);
            activeStartFinished = true;
          }
          if (pendingKey !== null) {
            await this.drainMissingClock(pendingKey, debuggerContext, sourceKey);
          }
          return;
        } finally {
          const compensationReleases: Array<() => Promise<unknown>> = [];
          const completedRedirect = completedRedirectToRelease;
          if (
            completedRedirect !== undefined &&
            !completedRedirectReleased &&
            this.isSourceStopped(sourceKey, isCanceled)
          ) {
            compensationReleases.push(() =>
              this.processorForSession(
                completedRedirect.sessionId,
              ).recordNetworkRequestFinished(
                completedRedirect.sessionId,
                completedRedirect.requestKey,
              ),
            );
          }
          const assigned = assignedRequest;
          if (
            assigned !== undefined &&
            !requestStartEstablished &&
            this.isSourceStopped(sourceKey, isCanceled)
          ) {
            compensationReleases.push(() =>
              assigned.processor.recordNetworkRequestFinished(
                debuggerContext.sessionId,
                assigned.requestKey,
              ),
            );
          }
          const compensationResults = await Promise.allSettled(
            compensationReleases.map((release) => Promise.resolve().then(release)),
          );
          if (ownsActiveStart && !activeStartFinished) {
            this.finishDirectRequestStart(sourceKey);
          }
          const rejectedCompensation = compensationResults.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          if (rejectedCompensation !== undefined) {
            await Promise.reject(
              rejectedCompensation.reason instanceof Error
                ? rejectedCompensation.reason
                : new Error("network request compensation release failed"),
            );
          }
        }
      }
      case "Network.requestWillBeSentExtraInfo": {
        const params = requestExtraInfoSchema.parse(rawParams);
        const record = assembler.onRequestExtraInfo(params);
        if (record !== null) {
          await this.persistExisting(sourceKey, params.requestId, record);
        } else {
          this.dropOrphanNetworkEvent(sourceKey, method, params.requestId);
        }
        return;
      }
      case "Network.responseReceivedExtraInfo": {
        const params = responseExtraInfoSchema.parse(rawParams);
        const record = assembler.onResponseExtraInfo(params);
        if (record !== null) {
          await this.persistExisting(sourceKey, params.requestId, record);
        } else {
          this.dropOrphanNetworkEvent(sourceKey, method, params.requestId);
        }
        return;
      }
      case "Network.responseReceived": {
        const params = responseReceivedSchema.parse(rawParams);
        if (assembler.currentRecord(params.requestId) === null) {
          if (await this.enqueueMissingClock(pendingKey, { source, method, rawParams, ...(admission === undefined ? {} : { admission }) }, debuggerContext, sourceKey)) {
            return;
          }
          this.dropOrphanNetworkEvent(sourceKey, method, params.requestId);
          return;
        }
        let record = assembler.onResponseReceived({
          requestId: params.requestId,
          timestampMs: this.toEpochMs(sourceKey, params.timestamp),
          response: {
            statusCode: params.response.status,
            headers: params.response.headers,
            ...(params.response.mimeType === undefined
              ? {}
              : { mimeType: params.response.mimeType }),
          },
          ...(params.hasExtraInfo === undefined ? {} : { hasExtraInfo: params.hasExtraInfo }),
        });
        if (record.resourceType === "EventSource" || record.resourceType === "WebSocket") {
          record = assembler.markStepNonBlocking(params.requestId);
        }
        await this.persistExisting(sourceKey, params.requestId, record);
        if (record.blocksStep === false) {
          await this.releaseStepRequest(record);
        }
        return;
      }
      case "Network.loadingFinished": {
        const params = loadingFinishedSchema.parse(rawParams);
        if (assembler.currentRecord(params.requestId) === null) {
          if (await this.enqueueMissingClock(pendingKey, { source, method, rawParams, ...(admission === undefined ? {} : { admission }) }, debuggerContext, sourceKey)) {
            return;
          }
          this.dropOrphanNetworkEvent(sourceKey, method, params.requestId);
          return;
        }
        const timestampMs = this.toEpochMs(sourceKey, params.timestamp);
        let record = assembler.onLoadingFinished({
          requestId: params.requestId,
          timestampMs,
        });
        const knownEncodedByteLength =
          params.encodedDataLength < 0 ? undefined : params.encodedDataLength;
        record = await this.captureResponseBody(
          source,
          sourceKey,
          record,
          knownEncodedByteLength,
        );
        if (isCanceled()) {
          return;
        }
        assembler.replaceCurrentRecord(params.requestId, record);
        await this.persistExisting(sourceKey, params.requestId, record, timestampMs);
        await this.releaseStepRequest(record);
        return;
      }
      case "Network.loadingFailed": {
        const params = loadingFailedSchema.parse(rawParams);
        if (assembler.currentRecord(params.requestId) === null) {
          if (await this.enqueueMissingClock(pendingKey, { source, method, rawParams, ...(admission === undefined ? {} : { admission }) }, debuggerContext, sourceKey)) {
            return;
          }
          this.dropOrphanNetworkEvent(sourceKey, method, params.requestId);
          return;
        }
        const timestampMs = this.toEpochMs(sourceKey, params.timestamp);
        const record = assembler.onLoadingFailed({
          requestId: params.requestId,
          timestampMs,
          errorText: params.errorText,
          canceled: params.canceled ?? false,
        });
        await this.persistExisting(sourceKey, params.requestId, record, timestampMs);
        await this.releaseStepRequest(record);
        return;
      }
      case "Network.webSocketCreated": {
        const params = webSocketCreatedSchema.parse(rawParams);
        this.webSockets.set(this.chainKey(sourceKey, params.requestId), {
          url: params.url,
          ...(params.initiator === undefined ? {} : { initiatorType: params.initiator.type }),
        });
        return;
      }
      case "Network.webSocketWillSendHandshakeRequest": {
        const params = webSocketHandshakeRequestSchema.parse(rawParams);
        const existing = assembler.currentRecord(params.requestId);
        if (existing !== null) {
          const updated = assembler.onRequestExtraInfo({
            requestId: params.requestId,
            headers: params.request.headers,
          });
          if (updated !== null) {
            await this.persistExisting(sourceKey, params.requestId, updated);
          }
          return;
        }
        const webSocketKey = this.chainKey(sourceKey, params.requestId);
        const created = this.webSockets.get(webSocketKey);
        if (created === undefined) {
          this.unavailableWebSocketKeys.add(webSocketKey);
          await this.persistNetworkGap(
            debuggerContext,
            sourceKey,
            "runtime_interrupted",
            `WebSocket creation context unavailable before handshake: ${params.requestId}`,
          );
          return;
        }
        await this.handleNetworkEventOwned(source, "Network.requestWillBeSent", {
          requestId: params.requestId,
          timestamp: params.timestamp,
          wallTime: params.wallTime,
          type: "WebSocket",
          request: {
            url: created.url,
            method: "GET",
            headers: params.request.headers,
          },
          ...(created.initiatorType === undefined
            ? {}
            : { initiator: { type: created.initiatorType } }),
        }, admission, replayOwner);
        return;
      }
      case "Network.webSocketHandshakeResponseReceived": {
        const params = webSocketHandshakeResponseSchema.parse(rawParams);
        if (this.unavailableWebSocketKeys.has(this.chainKey(sourceKey, params.requestId))) {
          return;
        }
        await this.handleNetworkEventOwned(source, "Network.responseReceived", {
          requestId: params.requestId,
          timestamp: params.timestamp,
          type: "WebSocket",
          response: {
            status: params.response.status,
            headers: params.response.headers,
          },
          hasExtraInfo: false,
        }, admission, replayOwner);
        return;
      }
      case "Network.webSocketClosed": {
        const params = webSocketClosedSchema.parse(rawParams);
        const webSocketKey = this.chainKey(sourceKey, params.requestId);
        if (this.unavailableWebSocketKeys.delete(webSocketKey)) {
          return;
        }
        if (assembler.currentRecord(params.requestId) === null) {
          this.webSockets.delete(webSocketKey);
          this.dropOrphanNetworkEvent(sourceKey, method, params.requestId);
          return;
        }
        const timestampMs = this.toEpochMs(sourceKey, params.timestamp);
        const record = assembler.onLoadingFinished({
          requestId: params.requestId,
          timestampMs,
        });
        await this.persistExisting(sourceKey, params.requestId, record, timestampMs);
        await this.releaseStepRequest(record);
        this.webSockets.delete(webSocketKey);
        return;
      }
      case "Network.webSocketFrameError": {
        const params = webSocketFrameErrorSchema.parse(rawParams);
        const webSocketKey = this.chainKey(sourceKey, params.requestId);
        if (this.unavailableWebSocketKeys.delete(webSocketKey)) {
          return;
        }
        if (assembler.currentRecord(params.requestId) === null) {
          this.webSockets.delete(webSocketKey);
          this.dropOrphanNetworkEvent(sourceKey, method, params.requestId);
          return;
        }
        const timestampMs = this.toEpochMs(sourceKey, params.timestamp);
        const record = assembler.onLoadingFailed({
          requestId: params.requestId,
          timestampMs,
          errorText: params.errorMessage,
          canceled: false,
        });
        await this.persistExisting(sourceKey, params.requestId, record, timestampMs);
        await this.releaseStepRequest(record);
        this.webSockets.delete(webSocketKey);
        return;
      }
      case "Network.webSocketFrameSent":
      case "Network.webSocketFrameReceived": {
        const params = webSocketFrameSchema.parse(rawParams);
        if (this.unavailableWebSocketKeys.has(this.chainKey(sourceKey, params.requestId))) {
          return;
        }
        const request = assembler.currentRecord(params.requestId);
        if (request === null) {
          this.dropOrphanNetworkEvent(sourceKey, method, params.requestId);
          return;
        }
        const observedAt = this.toEpochMs(sourceKey, params.timestamp);
        const { observedDuringStepId } = await this.processorForSession(
          debuggerContext.sessionId,
        ).recordNetworkMessageObserved(this.contextFromRecord(request), observedAt);
        if (isCanceled()) {
          return;
        }
        const messageId = this.makeEventId();
        const payload =
          params.response.opcode === 1
            ? {
                kind: "text" as const,
                text: params.response.payloadData,
                byteLength: utf8ByteLength(params.response.payloadData),
              }
            : {
                kind: "binary_metadata_only" as const,
                opcode: params.response.opcode,
                byteLength: this.base64ByteLength(params.response.payloadData),
              };
        const record = networkStreamMessageRecordSchema.parse({
          schemaVersion: SCHEMA_VERSION,
          messageId,
          requestKey: request.requestKey,
          sessionId: request.sessionId,
          startedInStepId: request.startedInStepId,
          observedDuringStepId,
          observedAt,
          kind: "websocket",
          direction: method === "Network.webSocketFrameSent" ? "sent" : "received",
          payload,
        });
        await this.persistPayload(
          sourceKey,
          this.contextFromRecord(request),
          observedAt,
          { kind: "network_stream_message", record },
          messageId,
        );
        return;
      }
      case "Network.eventSourceMessageReceived": {
        const params = eventSourceMessageSchema.parse(rawParams);
        const request = assembler.currentRecord(params.requestId);
        if (request === null) {
          this.dropOrphanNetworkEvent(sourceKey, method, params.requestId);
          return;
        }
        const observedAt = this.toEpochMs(sourceKey, params.timestamp);
        const { observedDuringStepId } = await this.processorForSession(
          debuggerContext.sessionId,
        ).recordNetworkMessageObserved(this.contextFromRecord(request), observedAt);
        if (isCanceled()) {
          return;
        }
        const messageId = this.makeEventId();
        const record = networkStreamMessageRecordSchema.parse({
          schemaVersion: SCHEMA_VERSION,
          messageId,
          requestKey: request.requestKey,
          sessionId: request.sessionId,
          startedInStepId: request.startedInStepId,
          observedDuringStepId,
          observedAt,
          kind: "sse",
          eventName: params.eventName,
          serverEventId: params.eventId,
          data: params.data,
          byteLength: utf8ByteLength(params.data),
        });
        await this.persistPayload(
          sourceKey,
          this.contextFromRecord(request),
          observedAt,
          { kind: "network_stream_message", record },
          messageId,
        );
        return;
      }
    }
  }

  private async captureResponseBody(
    source: DebuggerCommandTarget,
    sourceKey: string,
    record: RequestRecord,
    encodedDataLength: number | undefined,
  ): Promise<RequestRecord> {
    const config = await this.sessionConfigFor(record.sessionId);
    const filteredRule = this.matchedFilterRule(record, config);
    if (filteredRule !== null) {
      return requestRecordSchema.parse({
        ...record,
        responseBody: { kind: "filtered", ruleId: filteredRule },
      });
    }
    const mimeType = record.responseMimeType;
    if (mimeType !== undefined && !this.isTextMimeType(mimeType)) {
      return requestRecordSchema.parse({
        ...record,
        responseBody: {
          kind: "binary_metadata_only",
          ...(encodedDataLength === undefined
            ? {}
            : { byteLength: Math.round(encodedDataLength) }),
          mimeType,
        },
      });
    }
    if (
      encodedDataLength !== undefined &&
      encodedDataLength > config.responseBodyMaxBytes
    ) {
      return requestRecordSchema.parse({
        ...record,
        responseBody: {
          kind: "too_large",
          byteLength: Math.round(encodedDataLength),
          limitBytes: config.responseBodyMaxBytes,
        },
      });
    }
    try {
      const reply = responseBodyReplySchema.parse(
        await this.transport.sendCommand(source, "Network.getResponseBody", {
          requestId: record.keyParts.requestId,
        }),
      );
      const classified = classifyResponseBody({
        body: reply.body,
        base64Encoded: reply.base64Encoded,
        ...(mimeType === undefined ? {} : { mimeType }),
        maxBytes: config.responseBodyMaxBytes,
      });
      if (!("text" in classified)) {
        return requestRecordSchema.parse({ ...record, responseBody: classified.result });
      }
      const bodyRef = `${record.requestKey}#body`;
      await this.persistPayload(
        sourceKey,
        this.contextFromRecord(record),
        record.completedAt ?? record.startedAt,
        {
          kind: "response_body",
          requestKey: record.requestKey,
          bodyRef,
          text: classified.text,
        },
      );
      return requestRecordSchema.parse({
        ...record,
        responseBody: { ...classified.result, bodyRef },
      });
    } catch (cause: unknown) {
      return requestRecordSchema.parse({
        ...record,
        responseBody: {
          kind: "unavailable",
          reason: "cdp_get_response_body_failed",
          detail: cause instanceof Error ? cause.name : "unknown",
        },
      });
    }
  }

  private async persistExisting(
    sourceKey: string,
    requestId: CdpRequestId,
    record: RequestRecord,
    timestamp = record.completedAt ?? record.startedAt,
  ): Promise<void> {
    void requestId;
    await this.persistMetadata(sourceKey, this.contextFromRecord(record), timestamp, record);
  }

  private async releaseStepRequest(record: RequestRecord): Promise<void> {
    if (this.releasedStepRequests.has(record.requestKey)) {
      return;
    }
    await this.processorForSession(record.sessionId).recordNetworkRequestFinished(
      record.sessionId,
      record.requestKey,
    );
    this.releasedStepRequests.add(record.requestKey);
    this.releasedStepRequestSessions.set(record.requestKey, record.sessionId);
  }

  private persistMetadata(
    sourceKey: string,
    context: StepContext,
    timestamp: number,
    record: RequestRecord,
  ): Promise<void> {
    return this.persistPayload(sourceKey, context, timestamp, {
      kind: "request_metadata",
      record,
    });
  }

  private async persistPayload(
    sourceKey: string,
    context: StepContext,
    timestamp: number,
    payload: EventEnvelope["payload"],
    eventId: EventId = this.makeEventId(),
  ): Promise<void> {
    const seq = this.sourceSeq.get(sourceKey) ?? 0;
    this.sourceSeq.set(sourceKey, seq + 1);
    const ack = await this.ingestor.ingest({
      schemaVersion: SCHEMA_VERSION,
      eventId,
      source: "service_worker",
      sourceSeq: seq,
      sessionId: context.sessionId,
      scope: context.scope,
      sourceTimestamp: timestamp,
      payload,
    });
    if (ack.status === "rejected") {
      throw new Error(`network fact persistence rejected: ${ack.errorCode}`);
    }
  }

  private matchedFilterRule(record: RequestRecord, config: SessionConfig): string | null {
    for (const rule of config.userFilterRules) {
      const matched = (() => {
        switch (rule.kind) {
          case "domain": {
            try {
              return new URL(record.url).hostname === rule.pattern;
            } catch {
              return false;
            }
          }
          case "url_regex": {
            try {
              return new RegExp(rule.pattern, "u").test(record.url);
            } catch {
              return false;
            }
          }
          case "method":
            return record.method.toUpperCase() === rule.pattern.toUpperCase();
          case "content_type":
            return record.responseMimeType?.includes(rule.pattern) ?? false;
        }
      })();
      if (matched) {
        return rule.ruleId;
      }
    }
    return null;
  }

  private isTextMimeType(mimeType: string): boolean {
    return (
      mimeType.startsWith("text/") ||
      /(?:json|javascript|xml|graphql|x-www-form-urlencoded)/iu.test(mimeType)
    );
  }

  private assembler(sourceKey: string): NetworkEventAssembler {
    const existing = this.assemblers.get(sourceKey);
    if (existing !== undefined) {
      return existing;
    }
    const created = new NetworkEventAssembler();
    this.assemblers.set(sourceKey, created);
    return created;
  }

  private contextFromRecord(record: RequestRecord): StepContext {
    return {
      sessionId: record.sessionId,
      captureEpochId: record.captureEpochId,
      scope: record.scope,
    };
  }

  private toEpochMs(sourceKey: string, monotonicSeconds: number): number {
    return Math.round(this.requireClockOffset(sourceKey) + monotonicSeconds * 1_000);
  }

  private requireClockOffset(sourceKey: string): number {
    const offset = this.clockOffsetMs.get(sourceKey);
    if (offset === undefined) {
      throw new Error("CDP clock correlation unavailable");
    }
    return offset;
  }

  private sourceKey(context: DebuggerCaptureContext): string {
    const key = JSON.stringify([
      context.sessionId,
      context.tabId,
      context.childSessionId ?? null,
      context.attachEpoch,
    ]);
    this.sessionBySourceKey.set(key, context.sessionId);
    this.contextBySourceKey.set(key, { ...context });
    return key;
  }

  private isSourceStopped(sourceKey: string, isCanceled: () => boolean): boolean {
    return this.failedSourceKeys.has(sourceKey) || isCanceled();
  }

  private beginDirectRequestStart(
    sourceKey: string,
    replayOwner: ActiveReplayBatch | undefined,
  ): boolean {
    if (replayOwner !== undefined) {
      return false;
    }
    this.activeRequestStartsBySourceKey.set(
      sourceKey,
      (this.activeRequestStartsBySourceKey.get(sourceKey) ?? 0) + 1,
    );
    return true;
  }

  private finishDirectRequestStart(sourceKey: string): void {
    const remaining = (this.activeRequestStartsBySourceKey.get(sourceKey) ?? 1) - 1;
    if (remaining > 0) {
      this.activeRequestStartsBySourceKey.set(sourceKey, remaining);
    } else {
      this.activeRequestStartsBySourceKey.delete(sourceKey);
    }
  }

  private registerReplayBatch(
    sourceKey: string,
    chainKey: string,
    path: PendingBufferPath,
    remaining: number,
  ): ActiveReplayBatch {
    const batch: ActiveReplayBatch = {
      sourceKey,
      chainKey,
      path,
      remaining,
      invalidated: false,
      accounted: false,
    };
    const batches = this.activeReplayBatchesBySourceKey.get(sourceKey) ?? new Set();
    batches.add(batch);
    this.activeReplayBatchesBySourceKey.set(sourceKey, batches);
    return batch;
  }

  private releaseReplayBatch(batch: ActiveReplayBatch): void {
    const batches = this.activeReplayBatchesBySourceKey.get(batch.sourceKey);
    batches?.delete(batch);
    if (batches?.size === 0) {
      this.activeReplayBatchesBySourceKey.delete(batch.sourceKey);
    }
  }

  private isReplayBatchStopped(batch: ActiveReplayBatch): boolean {
    return batch.invalidated || this.failedSourceKeys.has(batch.sourceKey);
  }

  private chainKey(sourceKey: string, requestId: CdpRequestId): string {
    return JSON.stringify([sourceKey, requestId]);
  }

  private chainKeyBelongsToSources(key: string, sourceKeys: ReadonlySet<string>): boolean {
    try {
      const parsed: unknown = JSON.parse(key);
      return Array.isArray(parsed) && typeof parsed[0] === "string" && sourceKeys.has(parsed[0]);
    } catch {
      return false;
    }
  }

  private base64ByteLength(payloadData: string): number {
    return atob(payloadData).length;
  }

  private enqueuePending(
    key: string,
    event: PendingNetworkEvent,
    context?: DebuggerCaptureContext,
    sourceKey?: string,
  ): boolean {
    const queue = this.pendingEvents.get(key) ?? [];
    const nextBytes = this.nextPendingByteCount(key, event);
    if (nextBytes === null) {
      this.discardBufferedKey(key);
      this.overflowedPendingKeys.add(key);
      return false;
    }
    queue.push(event);
    this.pendingEvents.set(key, queue);
    this.pendingEventBytes.set(key, nextBytes);
    if (context !== undefined && sourceKey !== undefined) {
      this.schedulePendingDeadline(key, context, sourceKey);
    }
    return true;
  }

  private nextPendingByteCount(
    key: string,
    event: PendingNetworkEvent,
  ): number | null {
    const bufferedCount =
      (this.pendingEvents.get(key)?.length ?? 0) +
      (this.missingClockEvents.get(key)?.length ?? 0);
    if (bufferedCount >= this.pendingEventMaxCount) {
      return null;
    }
    const eventBytes = utf8ByteLength(JSON.stringify(event.rawParams ?? {}));
    const nextBytes = (this.pendingEventBytes.get(key) ?? 0) + eventBytes;
    if (nextBytes > this.pendingEventMaxBytes) {
      return null;
    }
    return nextBytes;
  }

  private takeBufferedEvents(
    collection: Map<string, PendingNetworkEvent[]>,
    key: string,
  ): PendingNetworkEvent[] | undefined {
    const buffered = collection.get(key);
    if (buffered === undefined) {
      return undefined;
    }
    collection.delete(key);
    const removedBytes = buffered.reduce(
      (sum, event) => sum + utf8ByteLength(JSON.stringify(event.rawParams ?? {})),
      0,
    );
    const remainingBytes = (this.pendingEventBytes.get(key) ?? 0) - removedBytes;
    if (remainingBytes > 0) {
      this.pendingEventBytes.set(key, remainingBytes);
    } else {
      this.pendingEventBytes.delete(key);
    }
    return buffered;
  }

  private discardBufferedKey(key: string): void {
    this.pendingEvents.delete(key);
    this.missingClockEvents.delete(key);
    this.pendingEventBytes.delete(key);
    this.clearPendingTimer(key);
  }

  private hasBufferedEvents(key: string): boolean {
    return this.pendingEvents.has(key) || this.missingClockEvents.has(key);
  }

  private pendingPathOf(key: string): PendingBufferPath {
    return this.missingClockEvents.has(key) ? "missing_clock" : "scope_pending";
  }

  /**
   * B2: a child target's network enable failed (e.g. its CDP session was torn
   * down mid-command with -32001). Events already buffered for that child
   * session are in-flight requests from before attach — their
   * Network.requestWillBeSent will never arrive. Discard them immediately and
   * open one precise non-recoverable gap instead of waiting out the pending
   * deadline. Safe to call even if the child never produced buffered events
   * (then nothing is reported beyond the manager's enable-delay gap).
   */
  discardSourceBuffers(context: DebuggerCaptureContext, cause: string): void {
    const sourceKey = this.sourceKey(context);
    if (this.failedSourceKeys.has(sourceKey)) {
      return;
    }
    this.failedSourceKeys.add(sourceKey);
    const ownedSourceKeys = new Set([sourceKey]);
    const owned = new Set<string>();
    for (const key of this.pendingEvents.keys()) {
      if (this.chainKeyBelongsToSources(key, ownedSourceKeys)) {
        owned.add(key);
      }
    }
    for (const key of this.missingClockEvents.keys()) {
      if (this.chainKeyBelongsToSources(key, ownedSourceKeys)) {
        owned.add(key);
      }
    }
    let discardedCount = this.activeRequestStartsBySourceKey.get(sourceKey) ?? 0;
    this.activeRequestStartsBySourceKey.delete(sourceKey);
    for (const key of owned) {
      discardedCount +=
        (this.pendingEvents.get(key)?.length ?? 0) +
        (this.missingClockEvents.get(key)?.length ?? 0);
      this.discardBufferedKey(key);
      this.overflowedPendingKeys.add(key);
    }
    const activeBatches = this.activeReplayBatchesBySourceKey.get(sourceKey);
    if (activeBatches !== undefined) {
      for (const batch of activeBatches) {
        if (!batch.accounted) {
          discardedCount += batch.remaining;
          batch.accounted = true;
        }
        batch.invalidated = true;
        batch.remaining = 0;
        this.clearPendingTimer(batch.chainKey);
        this.overflowedPendingKeys.add(batch.chainKey);
      }
      this.activeReplayBatchesBySourceKey.delete(sourceKey);
    }
    if (discardedCount > 0 && this.shouldOpenUnrecoverableGap(sourceKey)) {
      this.trackGapPersistence(
        sourceKey,
        this.persistNetworkGap(
          context,
          sourceKey,
          "other_unrecoverable_window",
          `child target network enable failed (${cause}); ` +
            `${String(discardedCount)} in-flight request event(s) at attach discarded`,
        ),
      );
    }
  }

  private schedulePendingDeadline(
    key: string,
    context: DebuggerCaptureContext,
    sourceKey: string,
  ): void {
    if (this.pendingEventDeadlineMs <= 0 || this.pendingTimers.has(key)) {
      return;
    }
    this.pendingMeta.set(key, { context, sourceKey });
    const timer = setTimeout(() => {
      this.pendingTimers.delete(key);
      const meta = this.pendingMeta.get(key);
      this.pendingMeta.delete(key);
      const hadBufferedEvents = this.hasBufferedEvents(key);
      // Derive the path from live buffer state BEFORE discarding: a chain that
      // moved from missing-clock into the scope-pending queue still reports its
      // earlier cause, which is the accurate one for the user.
      const path = this.pendingPathOf(key);
      const discardedCount = hadBufferedEvents
        ? (this.pendingEvents.get(key)?.length ?? 0) +
          (this.missingClockEvents.get(key)?.length ?? 0)
        : 0;
      this.discardBufferedKey(key);
      if (hadBufferedEvents && meta !== undefined) {
        this.overflowedPendingKeys.add(key);
        this.trackGapPersistence(
          meta.sourceKey,
          this.persistBufferOverflowGap(
            meta.context,
            meta.sourceKey,
            key,
            discardedCount,
            path,
          ),
        );
      }
    }, this.pendingEventDeadlineMs);
    this.pendingTimers.set(key, timer);
  }

  private clearPendingTimer(key: string): void {
    const timer = this.pendingTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.pendingTimers.delete(key);
    }
    this.pendingMeta.delete(key);
  }

  private trackGapPersistence(sourceKey: string, persistence: Promise<void>): void {
    const state = this.gapPersistenceBySourceKey.get(sourceKey) ?? {
      tail: Promise.resolve(),
      failures: [],
    };
    void persistence.catch(() => undefined);
    const tracked = state.tail.catch(() => undefined).then(() => persistence);
    state.tail = tracked;
    void tracked.catch((cause: unknown) => {
      state.failures.push(cause);
    });
    this.gapPersistenceBySourceKey.set(sourceKey, state);
  }

  private async persistBufferOverflowGap(
    context: DebuggerCaptureContext,
    sourceKey: string,
    pendingKey: string,
    discardedCount: number,
    path: PendingBufferPath,
  ): Promise<void> {
    if (!this.shouldOpenUnrecoverableGap(sourceKey)) {
      return;
    }
    const detail =
      path === "missing_clock"
        ? `in-flight request events before Network.requestWillBeSent (attach race); ` +
          `${String(discardedCount)} event(s) discarded: ${pendingKey}`
        : `request scope unresolved after ${String(this.pendingEventDeadlineMs)}ms; ` +
          `${String(discardedCount)} event(s) discarded: ${pendingKey}`;
    await this.persistNetworkGap(
      context,
      sourceKey,
      "other_unrecoverable_window",
      detail,
    );
  }

  private async persistNetworkGap(
    context: DebuggerCaptureContext,
    sourceKey: string,
    reason: CaptureGapReason,
    detail: string,
  ): Promise<void> {
    const observedAt = this.now();
    const record = captureGapRecordSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      gapId: this.makeGapId(),
      scope: {
        sessionId: context.sessionId,
        tabId: context.tabId,
        collector: "debugger_network",
        cdpTarget: {
          attachEpoch: context.attachEpoch,
          ...(context.childSessionId === undefined
            ? {}
            : { sessionId: context.childSessionId }),
        },
      },
      reason,
      observedStartedAt: observedAt,
      boundaryConfidence: "estimated",
      recoverable: false,
      affectedCapabilities: ["network_metadata", "network_bodies"],
      detail,
    });
    const seq = this.sourceSeq.get(sourceKey) ?? 0;
    this.sourceSeq.set(sourceKey, seq + 1);
    const ack = await this.ingestor.ingest(
      eventEnvelopeSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        eventId: this.makeEventId(),
        source: "service_worker",
        sourceSeq: seq,
        sessionId: context.sessionId,
        scope: { tabId: context.tabId },
        sourceTimestamp: observedAt,
        payload: { kind: "capture_gap_open", record },
      }),
    );
    if (ack.status === "rejected") {
      throw new Error(`network CaptureGap persistence rejected: ${ack.errorCode}`);
    }
  }

  private async enqueueMissingClock(
    pendingKey: string | null,
    event: PendingNetworkEvent,
    context: DebuggerCaptureContext,
    sourceKey: string,
  ): Promise<boolean> {
    if (pendingKey === null || this.clockOffsetMs.has(sourceKey)) {
      return false;
    }
    const queue = this.missingClockEvents.get(pendingKey) ?? [];
    const nextBytes = this.nextPendingByteCount(pendingKey, event);
    if (nextBytes === null) {
      const bufferedCount = queue.length;
      this.discardBufferedKey(pendingKey);
      this.overflowedPendingKeys.add(pendingKey);
      await this.persistBufferOverflowGap(
        context,
        sourceKey,
        pendingKey,
        bufferedCount + 1,
        "missing_clock",
      );
      return true;
    }
    queue.push(event);
    this.missingClockEvents.set(pendingKey, queue);
    this.pendingEventBytes.set(pendingKey, nextBytes);
    this.schedulePendingDeadline(pendingKey, context, sourceKey);
    return true;
  }

  private async drainMissingClock(
    pendingKey: string,
    context: DebuggerCaptureContext,
    sourceKey: string,
  ): Promise<void> {
    const path = this.pendingPathOf(pendingKey);
    const buffered = this.takeBufferedEvents(this.missingClockEvents, pendingKey);
    if (buffered === undefined) {
      return;
    }
    const batch = this.registerReplayBatch(sourceKey, pendingKey, path, buffered.length);
    try {
      for (const event of buffered) {
        if (this.isReplayBatchStopped(batch)) {
          return;
        }
        await this.handleNetworkEventOwned(
          event.source,
          event.method,
          event.rawParams,
          event.admission,
          batch,
        );
        if (this.isReplayBatchStopped(batch)) {
          return;
        }
        batch.remaining -= 1;
      }
    } catch {
      if (this.isReplayBatchStopped(batch)) {
        return;
      }
      this.discardBufferedKey(pendingKey);
      this.overflowedPendingKeys.add(pendingKey);
      await this.persistBufferOverflowGap(
        context,
        sourceKey,
        pendingKey,
        batch.remaining,
        batch.path,
      );
    } finally {
      this.releaseReplayBatch(batch);
      if (!this.hasBufferedEvents(pendingKey)) {
        this.clearPendingTimer(pendingKey);
      }
    }
  }
  private shouldOpenUnrecoverableGap(sourceKey: string): boolean {
    if (this.orphanGapWindowMs <= 0) {
      return true;
    }
    const now = this.now();
    const last = this.lastUnrecoverableGapAtMs.get(sourceKey);
    if (last !== undefined && now - last < this.orphanGapWindowMs) {
      return false;
    }
    this.lastUnrecoverableGapAtMs.set(sourceKey, now);
    return true;
  }

  /**
   * Terminal/stream events may reference a request whose start was never
   * observed (in flight before attach, worker attach race, rejected ingest
   * during a pause window). That blind window is already represented by the
   * attach-lifecycle CaptureGaps, so the orphan event is counted and dropped
   * instead of aborting event routing (task 10 R3 minimal degradation).
   *
   * When a classifier is provided, explained orphans (covered by an existing
   * attach/pause gap) are counted only. Unexplained orphans open one
   * deduplicated nonrecoverable CaptureGap per source/orphan-gap window.
   */
  private dropOrphanNetworkEvent(
    sourceKey: string,
    method: string,
    requestId: CdpRequestId,
  ): void {
    const key = this.chainKey(sourceKey, requestId);
    const dropped = (this.orphanedNetworkEvents.get(key) ?? 0) + 1;
    this.orphanedNetworkEvents.set(key, dropped);
    if (dropped === 1) {
      console.debug(
        `[ai-crawler-helper] dropped ${method} without request chain: ${requestId}`,
      );
    }
    if (this.classifyOrphan !== undefined) {
      if (this.classifyOrphan(sourceKey, method, requestId) === "explained") {
        return;
      }
    }
    if (this.orphanGapWindowMs > 0) {
      if (!this.shouldOpenUnrecoverableGap(sourceKey)) {
        return;
      }
      const context = this.contextBySourceKey.get(sourceKey);
      if (context !== undefined) {
        this.trackGapPersistence(
          sourceKey,
          this.persistNetworkGap(
            context,
            sourceKey,
            "other_unrecoverable_window",
            `unexplained orphan network event: ${method} ${requestId}`,
          ),
        );
      }
    }
  }

  private async replayPending(
    key: string,
    sourceKey: string,
    context: DebuggerCaptureContext,
  ): Promise<void> {
    if (this.replayingPendingKeys.has(key)) {
      return;
    }
    const path = this.pendingPathOf(key);
    const queue = this.takeBufferedEvents(this.pendingEvents, key);
    if (queue === undefined) {
      return;
    }
    const batch = this.registerReplayBatch(sourceKey, key, path, queue.length);
    this.replayingPendingKeys.add(key);
    try {
      for (const [index, event] of queue.entries()) {
        if (this.isReplayBatchStopped(batch)) {
          return;
        }
        await this.handleNetworkEventOwned(
          event.source,
          event.method,
          event.rawParams,
          event.admission,
          batch,
        );
        if (this.isReplayBatchStopped(batch)) {
          return;
        }
        batch.remaining -= 1;
        const requeued = this.pendingEvents.get(key);
        if (requeued !== undefined) {
          for (const remaining of queue.slice(index + 1)) {
            const mapBackedCount =
              (this.pendingEvents.get(key)?.length ?? 0) +
              (this.missingClockEvents.get(key)?.length ?? 0);
            const livePath = this.pendingPathOf(key);
            if (!this.enqueuePending(key, remaining)) {
              const discardedCount = mapBackedCount + batch.remaining;
              batch.accounted = true;
              batch.remaining = 0;
              await this.persistBufferOverflowGap(
                context,
                sourceKey,
                key,
                discardedCount,
                livePath,
              );
              return;
            }
            batch.remaining -= 1;
          }
          return;
        }
      }
    } finally {
      this.releaseReplayBatch(batch);
      this.replayingPendingKeys.delete(key);
      if (!this.hasBufferedEvents(key)) {
        this.clearPendingTimer(key);
      }
    }
  }

}
