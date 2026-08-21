import {
  STORES,
  getRecord,
  isQuotaExceededError,
  runAtomicWrite,
  type StoreName,
} from "./database";
import {
  envelopeSourceKey,
  inboxEntrySchema,
  type EnvelopeAck,
  type EventEnvelope,
  type FactPayload,
} from "../schemas/event-envelope";
import {
  sessionControlRecordSchema,
  sessionRecordSchema,
  type SessionControlRecord,
} from "../schemas/session";
import { SCHEMA_VERSION } from "../schemas/common";
import {
  inFlightRequestRecordSchema,
  requestRecordSchema,
  responseBodyRecordSchema,
  type ResponseBodyRecord,
} from "../schemas/network";
import {
  draftStepSchema,
  draftUserActionStepSchema,
  storedStepSchema,
  type DraftStep,
  type ExplicitContextLink,
  type StoredStep,
} from "../schemas/step";
import { captureGapRecordSchema } from "../schemas/capture-gap";
import { jsonUtf8ByteLength, utf8ByteLength } from "../shared/json-bytes";
import { acceptsFacts } from "../core/session-state-machine";
import type { CapacityGuard } from "../core/capacity-guard";
import type { StoragePressureController } from "./storage-pressure";
import type { StepId, SessionId } from "../shared/ids";

/**
 * FactIngestor (design 12, state-management spec).
 *
 * ONE short IndexedDB transaction per fact, atomically committing:
 *   durable inbox entry + the fact record + step linkage indexes +
 *   logical byte counters + sessionControl.lastCommittedSeq/EventId/At.
 *
 * The sender is ACKed only after the transaction completed. Replayed
 * envelopes (same eventId) are detected via the inbox and resolve as
 * `duplicate` without any writes — idempotent by construction.
 *
 * Response-body soft budget (PRD 4.13): measured on actual UTF-8 bytes;
 * once exceeded, new bodies are stored as an explicit
 * `unavailable/session_body_soft_budget_reached` marker while ALL other fact
 * types continue to commit.
 *
 * Hard CapacityGuard admission runs BEFORE the transaction; a rejection
 * triggers the transactional safe-stop (storage-pressure controller) and the
 * envelope is NACKed non-retryable — the paused interval is covered by a
 * CaptureGap, never backfilled.
 */

const FACT_TXN_STORES: readonly StoreName[] = [
  STORES.inbox,
  STORES.sessionControl,
  STORES.sessions,
  STORES.steps,
  STORES.domRecords,
  STORES.navigations,
  STORES.requests,
  STORES.inFlightRequests,
  STORES.responseBodies,
  STORES.networkStreamMessages,
  STORES.storageSnapshots,
  STORES.storageDiffs,
  STORES.captureGaps,
];

interface FactWritePlan {
  targetStore: StoreName;
  targetKey: string;
  /** Executed inside the transaction after duplicate check. */
  execute: (txn: IDBTransaction, control: SessionControlRecord) => Promise<FactWriteOutcome>;
}

interface FactWriteOutcome {
  factBytes: number;
  responseBodyBytes: number;
  /** Present only when a token-guarded candidate deletion actually occurred. */
  deletedCandidateStepId?: StepId;
}

const isLifecycleCleanupEnvelope = (envelope: EventEnvelope): boolean =>
  envelope.source === "service_worker" && envelope.payload.kind === "capture_gap_close";

export class FactIngestor {
  constructor(
    private readonly db: IDBDatabase,
    private readonly guard: CapacityGuard,
    private readonly pressure: StoragePressureController,
    private readonly now: () => number = () => Date.now(),
    /**
     * Called on every ingest, before admission. Lets the adaptive stop
     * scheduler observe session activity (quiescent early-exit).
     */
    private readonly onIngestActivity?: (sessionId: SessionId) => void,
  ) {}

  async ingest(envelope: EventEnvelope): Promise<EnvelopeAck> {
    return this.ingestEnvelope(envelope, false);
  }

  /** Trusted Service Worker path for teardown after the public fact gate closes. */
  async ingestLifecycleCleanup(envelope: EventEnvelope): Promise<EnvelopeAck> {
    if (!isLifecycleCleanupEnvelope(envelope)) {
      throw new TypeError(
        "trusted lifecycle cleanup requires a service_worker capture_gap_close envelope",
      );
    }
    return this.ingestEnvelope(envelope, true);
  }

  private async ingestEnvelope(
    envelope: EventEnvelope,
    lifecycleCleanup: boolean,
  ): Promise<EnvelopeAck> {
    this.onIngestActivity?.(envelope.sessionId);
    if (!lifecycleCleanup) {
      const estimatedBytes = jsonUtf8ByteLength(envelope) * 2; // fact + inbox + control upper bound
      const admission = await this.guard.admit(estimatedBytes);
      if (!admission.admitted) {
        await this.pressure.safeStop(envelope.sessionId, "headroom_exhausted", this.now());
        return {
          status: "rejected",
          eventId: envelope.eventId,
          errorCode:
            admission.reason === "estimate_unavailable"
              ? "CAPACITY_ESTIMATE_UNAVAILABLE"
              : "CAPACITY_HEADROOM_EXHAUSTED",
          retryable: false,
        };
      }
    }

    try {
      const ack = await this.commit(envelope, lifecycleCleanup);
      if (ack.status === "committed") {
        this.guard.reportCommittedBytes(ack.committedBytes);
      }
      return ack;
    } catch (cause) {
      if (isQuotaExceededError(cause)) {
        this.guard.reportWriteFailure("quota");
        await this.pressure.safeStop(envelope.sessionId, "quota_exceeded_error", this.now());
        return {
          status: "rejected",
          eventId: envelope.eventId,
          errorCode: "CAPACITY_HEADROOM_EXHAUSTED",
          retryable: false,
        };
      }
      if (cause instanceof GateClosedError) {
        return {
          status: "rejected",
          eventId: envelope.eventId,
          errorCode: "SESSION_NOT_ACCEPTING_FACTS",
          retryable: false,
        };
      }
      return {
        status: "rejected",
        eventId: envelope.eventId,
        errorCode: "PERSISTENCE_TRANSACTION_FAILED",
        // Transient transaction failures are replayable by contract.
        retryable: true,
      };
    }
  }

  async hasCommittedEvent(eventId: EventEnvelope["eventId"]): Promise<boolean> {
    const txn = this.db.transaction([STORES.inbox], "readonly");
    const raw = await getRecord(txn.objectStore(STORES.inbox), eventId);
    if (raw === undefined) {
      return false;
    }
    inboxEntrySchema.parse(raw);
    return true;
  }

  // -------------------------------------------------------------------------

  private async commit(
    envelope: EventEnvelope,
    lifecycleCleanup: boolean,
  ): Promise<EnvelopeAck> {
    const receivedAt = this.now();
    return runAtomicWrite(this.db, FACT_TXN_STORES, async (txn) => {
      const controlStore = txn.objectStore(STORES.sessionControl);
      const inboxStore = txn.objectStore(STORES.inbox);

      // Idempotent replay: inbox is the dedupe ledger.
      const existing = await getRecord(inboxStore, envelope.eventId);
      if (existing !== undefined) {
        return { status: "duplicate", eventId: envelope.eventId } satisfies EnvelopeAck;
      }

      const controlRaw = await getRecord(controlStore, envelope.sessionId);
      if (controlRaw === undefined) {
        throw new GateClosedError(`no sessionControl for ${envelope.sessionId}`);
      }
      const control = sessionControlRecordSchema.parse(controlRaw);
      if (!acceptsFacts(control.lifecycle) && !lifecycleCleanup) {
        throw new GateClosedError(`lifecycle ${control.lifecycle} does not accept facts`);
      }

      const plan = this.planWrite(envelope, control);
      const outcome = await plan.execute(txn, control);

      const committedAt = this.now();
      const inboxEntry = inboxEntrySchema.parse({
        schemaVersion: SCHEMA_VERSION,
        eventId: envelope.eventId,
        sessionId: envelope.sessionId,
        sourceKey: envelopeSourceKey(envelope),
        sourceSeq: envelope.sourceSeq,
        payloadKind: envelope.payload.kind,
        receivedAt,
        committedAt,
        targetStore: plan.targetStore,
        targetKey: plan.targetKey,
      });
      inboxStore.put(inboxEntry);

      const sourceKey = envelopeSourceKey(envelope);
      const previousSeq = control.lastCommittedSeqBySource[sourceKey] ?? -1;
      const updatedControl: SessionControlRecord = sessionControlRecordSchema.parse({
        ...control,
        lastCommittedSeqBySource: {
          ...control.lastCommittedSeqBySource,
          [sourceKey]: Math.max(previousSeq, envelope.sourceSeq),
        },
        lastCommittedEventId: envelope.eventId,
        lastCommittedAt: committedAt,
        openStepIds: this.nextOpenStepIds(control.openStepIds, envelope.payload, outcome),
        counters: {
          totalLogicalBytes:
            control.counters.totalLogicalBytes + outcome.factBytes + outcome.responseBodyBytes,
          responseBodyLogicalBytes:
            control.counters.responseBodyLogicalBytes + outcome.responseBodyBytes,
          factCount:
            control.counters.factCount +
            (envelope.payload.kind === "observation_checkpoint" ? 0 : 1),
        },
      });
      controlStore.put(updatedControl);

      return {
        status: "committed",
        eventId: envelope.eventId,
        committedBytes: outcome.factBytes + outcome.responseBodyBytes,
      } satisfies EnvelopeAck;
    });
  }

  private nextOpenStepIds(
    current: readonly StepId[],
    payload: FactPayload,
    outcome: FactWriteOutcome,
  ): StepId[] {
    if (payload.kind === "step_draft_upsert") {
      return current.includes(payload.step.stepId)
        ? [...current]
        : [...current, payload.step.stepId];
    }
    if (payload.kind === "step_seal") {
      return current.filter((id) => id !== payload.step.stepId);
    }
    if (
      payload.kind === "step_draft_delete" &&
      outcome.deletedCandidateStepId !== undefined
    ) {
      return current.filter((id) => id !== outcome.deletedCandidateStepId);
    }
    return [...current];
  }

  // -------------------------------------------------------------------------
  // Per-payload write plans
  // -------------------------------------------------------------------------

  private planWrite(envelope: EventEnvelope, control: SessionControlRecord): FactWritePlan {
    const payload = envelope.payload;
    switch (payload.kind) {
      case "observation_checkpoint":
        return {
          targetStore: STORES.inbox,
          targetKey: payload.observationEventId,
          execute: () => Promise.resolve({ factBytes: 0, responseBodyBytes: 0 }),
        };
      case "step_draft_upsert":
        return this.planStepPut(payload.step);
      case "step_draft_delete":
        return {
          targetStore: STORES.steps,
          targetKey: payload.stepId,
          execute: async (txn) => {
            const store = txn.objectStore(STORES.steps);
            const raw = await getRecord(store, payload.stepId);
            const parsed = draftUserActionStepSchema.safeParse(raw);
            if (
              !parsed.success ||
              !parsed.data.candidate ||
              parsed.data.sessionId !== control.sessionId ||
              parsed.data.candidateToken !== payload.candidateToken
            ) {
              return { factBytes: 0, responseBodyBytes: 0 };
            }
            store.delete(payload.stepId);
            return {
              factBytes: 0,
              responseBodyBytes: 0,
              deletedCandidateStepId: payload.stepId,
            };
          },
        };
      case "step_seal":
        return this.planStepPut(payload.step);
      case "step_review_update":
        return {
          targetStore: STORES.steps,
          targetKey: payload.stepId,
          execute: async (txn) => {
            const store = txn.objectStore(STORES.steps);
            const raw = await getRecord(store, payload.stepId);
            if (raw === undefined) {
              return { factBytes: 0, responseBodyBytes: 0 };
            }
            const step = storedStepSchema.parse(raw);
            // Rebuild from the parsed record and touch only review fields, so
            // no raw fact can be altered by a review action (PRD 4.15).
            const next: Record<string, unknown> = { ...step };
            if (payload.excluded !== undefined) {
              next.excluded = payload.excluded;
            }
            if (payload.note === null) {
              delete next.note;
            } else if (payload.note !== undefined) {
              next.note = payload.note;
            }
            const updated = storedStepSchema.parse(next);
            store.put(updated);
            return { factBytes: jsonUtf8ByteLength(updated), responseBodyBytes: 0 };
          },
        };
      case "dom_record":
        return {
          targetStore: STORES.domRecords,
          targetKey: payload.record.domRecordId,
          execute: async (txn) => {
            txn.objectStore(STORES.domRecords).put(payload.record);
            await this.linkToDraftStep(txn, payload.record.stepId, (step) => ({
              ...step,
              domRecordIds: appendUnique(step.domRecordIds, payload.record.domRecordId),
            }));
            return { factBytes: jsonUtf8ByteLength(payload.record), responseBodyBytes: 0 };
          },
        };
      case "navigation_record":
        return this.plainPut(STORES.navigations, payload.record.navigationRecordId, payload.record);
      case "request_metadata":
        return {
          targetStore: STORES.requests,
          targetKey: payload.record.requestKey,
          execute: async (txn) => {
            txn.objectStore(STORES.requests).put(payload.record);
            await this.linkToDraftStep(txn, payload.record.startedInStepId, (step) => ({
              ...step,
              requestKeys: appendUnique(step.requestKeys, payload.record.requestKey),
            }));
            const inFlightStore = txn.objectStore(STORES.inFlightRequests);
            if (payload.record.completedAt !== undefined || payload.record.failure !== undefined) {
              inFlightStore.delete(payload.record.requestKey);
            } else {
              inFlightStore.put(
                inFlightRequestRecordSchema.parse({
                  schemaVersion: SCHEMA_VERSION,
                  requestKey: payload.record.requestKey,
                  keyParts: payload.record.keyParts,
                  sessionId: payload.record.sessionId,
                  captureEpochId: payload.record.captureEpochId,
                  scope: payload.record.scope,
                  startedInStepId: payload.record.startedInStepId,
                  blocksStep: payload.record.blocksStep ?? true,
                  phase:
                    payload.record.statusCode === undefined
                      ? "request_started"
                      : "response_received",
                  startedAt: payload.record.startedAt,
                  ...(payload.record.cdpClockOffsetMs === undefined
                    ? {}
                    : { cdpClockOffsetMs: payload.record.cdpClockOffsetMs }),
                  updatedAt: envelope.sourceTimestamp,
                }),
              );
            }
            return { factBytes: jsonUtf8ByteLength(payload.record), responseBodyBytes: 0 };
          },
        };
      case "response_body":
        return this.planResponseBody(payload, control);
      case "network_stream_message":
        return this.plainPut(
          STORES.networkStreamMessages,
          payload.record.messageId,
          payload.record,
        );
      case "storage_snapshot":
        return this.plainPut(STORES.storageSnapshots, payload.record.storageRecordId, payload.record);
      case "storage_diff":
        return {
          targetStore: STORES.storageDiffs,
          targetKey: payload.record.storageRecordId,
          execute: async (txn) => {
            txn.objectStore(STORES.storageDiffs).put(payload.record);
            await this.linkToDraftStep(txn, payload.record.observedDuringStepId, (step) => ({
              ...step,
              storageDiffIds: appendUnique(step.storageDiffIds, payload.record.storageRecordId),
            }));
            return { factBytes: jsonUtf8ByteLength(payload.record), responseBodyBytes: 0 };
          },
        };
      case "capture_gap_open":
        return {
          targetStore: STORES.captureGaps,
          targetKey: payload.record.gapId,
          execute: async (txn) => {
            txn.objectStore(STORES.captureGaps).put(payload.record);
            // Any gap degrades capture quality (orthogonal to lifecycle).
            const sessionsStore = txn.objectStore(STORES.sessions);
            const sessionRaw = await getRecord(sessionsStore, payload.record.scope.sessionId);
            if (sessionRaw !== undefined) {
              const session = sessionRecordSchema.parse(sessionRaw);
              if (session.captureQuality !== "degraded") {
                sessionsStore.put(
                  sessionRecordSchema.parse({ ...session, captureQuality: "degraded" }),
                );
              }
            }
            return { factBytes: jsonUtf8ByteLength(payload.record), responseBodyBytes: 0 };
          },
        };
      case "capture_gap_close":
        return {
          targetStore: STORES.captureGaps,
          targetKey: payload.gapId,
          execute: async (txn) => {
            const store = txn.objectStore(STORES.captureGaps);
            const raw = await getRecord(store, payload.gapId);
            if (raw !== undefined) {
              const gap = captureGapRecordSchema.parse(raw);
              const closed = captureGapRecordSchema.parse({
                ...gap,
                observedEndedAt: payload.observedEndedAt,
                ...(payload.recovery === undefined ? {} : { recovery: payload.recovery }),
              });
              store.put(closed);
            }
            return { factBytes: 0, responseBodyBytes: 0 };
          },
        };
    }
  }

  /**
   * Soft budget: only new response BODIES pause; the request metadata was and
   * remains committed via `request_metadata` facts (PRD 4.13).
   */
  private planResponseBody(
    payload: Extract<FactPayload, { kind: "response_body" }>,
    control: SessionControlRecord,
  ): FactWritePlan {
    return {
      targetStore: STORES.responseBodies,
      targetKey: payload.bodyRef,
      execute: async (txn) => {
        const bodyBytes = utf8ByteLength(payload.text);
        const budget = await this.readSoftBudget(txn, control);
        const withinBudget =
          control.counters.responseBodyLogicalBytes + bodyBytes <= budget;

        const requestsStore = txn.objectStore(STORES.requests);
        const requestRaw = await getRecord(requestsStore, payload.requestKey);

        if (!withinBudget) {
          if (requestRaw !== undefined) {
            const request = requestRecordSchema.parse(requestRaw);
            requestsStore.put(
              requestRecordSchema.parse({
                ...request,
                responseBody: {
                  kind: "unavailable",
                  reason: "session_body_soft_budget_reached",
                },
              }),
            );
          }
          return { factBytes: 0, responseBodyBytes: 0 };
        }

        const bodyRecord: ResponseBodyRecord = responseBodyRecordSchema.parse({
          schemaVersion: SCHEMA_VERSION,
          bodyRef: payload.bodyRef,
          requestKey: payload.requestKey,
          sessionId: control.sessionId,
          text: payload.text,
          byteLength: bodyBytes,
          recordedAt: this.now(),
        });
        txn.objectStore(STORES.responseBodies).put(bodyRecord);
        if (requestRaw !== undefined) {
          const request = requestRecordSchema.parse(requestRaw);
          requestsStore.put(
            requestRecordSchema.parse({
              ...request,
              responseBody: {
                kind: "captured",
                bodyRef: payload.bodyRef,
                byteLength: bodyBytes,
                encoding: "utf8",
              },
            }),
          );
        }
        return {
          factBytes: jsonUtf8ByteLength(bodyRecord) - bodyBytes,
          responseBodyBytes: bodyBytes,
        };
      },
    };
  }

  private async readSoftBudget(
    txn: IDBTransaction,
    control: SessionControlRecord,
  ): Promise<number> {
    const sessionRaw = await getRecord(txn.objectStore(STORES.sessions), control.sessionId);
    if (sessionRaw === undefined) {
      throw new GateClosedError(`no session record for ${control.sessionId}`);
    }
    return sessionRecordSchema.parse(sessionRaw).config.responseBodySoftBudgetBytes;
  }

  private plainPut(
    storeName: StoreName,
    key: string,
    record: unknown,
  ): FactWritePlan {
    return {
      targetStore: storeName,
      targetKey: key,
      execute: (txn) => {
        txn.objectStore(storeName).put(record);
        return Promise.resolve({
          factBytes: jsonUtf8ByteLength(record),
          responseBodyBytes: 0,
        });
      },
    };
  }

  private planStepPut(step: StoredStep): FactWritePlan {
    return {
      targetStore: STORES.steps,
      targetKey: step.stepId,
      execute: async (txn) => {
        const store = txn.objectStore(STORES.steps);
        const existingRaw = await getRecord(store, step.stepId);
        const existing =
          existingRaw === undefined ? null : storedStepSchema.parse(existingRaw);
        const outgoingContextLinks = [
          ...(existing?.outgoingContextLinks ?? []),
          ...(step.outgoingContextLinks ?? []),
        ].reduce<ExplicitContextLink[]>(appendContextLinkIfMissing, []);
        const mergedStep = storedStepSchema.parse({
          ...step,
          ...(outgoingContextLinks.length === 0 ? {} : { outgoingContextLinks }),
        });
        store.put(mergedStep);

        if (step.contextLink?.state === "verified") {
          if (step.contextLink.link.targetStepId !== step.stepId) {
            throw new Error("cross-context link target does not match its Step");
          }
          await this.persistReverseContextLink(txn, step.contextLink.link, step.sessionId);
        }
        return {
          factBytes: jsonUtf8ByteLength(mergedStep),
          responseBodyBytes: 0,
        };
      },
    };
  }

  private async persistReverseContextLink(
    txn: IDBTransaction,
    link: ExplicitContextLink,
    targetSessionId: StoredStep["sessionId"],
  ): Promise<void> {
    if (link.sourceStepId === link.targetStepId) {
      throw new Error("cross-context link cannot target its source Step");
    }
    const store = txn.objectStore(STORES.steps);
    const sourceRaw = await getRecord(store, link.sourceStepId);
    if (sourceRaw === undefined) {
      throw new Error(`cross-context source Step ${link.sourceStepId} is missing`);
    }
    const source = storedStepSchema.parse(sourceRaw);
    if (source.sessionId !== targetSessionId) {
      throw new Error("cross-context source and target Steps belong to different sessions");
    }
    const outgoingContextLinks = appendContextLinkIfMissing(
      source.outgoingContextLinks ?? [],
      link,
    );
    store.put(storedStepSchema.parse({ ...source, outgoingContextLinks }));
  }

  private async linkToDraftStep(
    txn: IDBTransaction,
    stepId: string,
    update: (step: DraftStep) => DraftStep,
  ): Promise<void> {
    const store = txn.objectStore(STORES.steps);
    const raw = await getRecord(store, stepId);
    if (raw === undefined) {
      return;
    }
    const parsed = draftStepSchema.safeParse(raw);
    if (!parsed.success) {
      // Sealed step: linkage arrays are frozen at seal time; late responses
      // update the request record itself, never the sealed step (design 6.3).
      return;
    }
    store.put(draftStepSchema.parse(update(parsed.data)));
  }
}

class GateClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateClosedError";
  }
}

const appendUnique = (list: readonly string[], value: string): string[] =>
  list.includes(value) ? [...list] : [...list, value];

const appendContextLinkIfMissing = (
  links: readonly ExplicitContextLink[],
  value: ExplicitContextLink,
): ExplicitContextLink[] =>
  links.some(
    (link) =>
      link.targetStepId === value.targetStepId &&
      link.evidenceType === value.evidenceType &&
      link.evidenceId === value.evidenceId,
  )
    ? [...links]
    : [...links, value];
