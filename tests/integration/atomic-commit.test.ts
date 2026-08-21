import { describe, expect, it } from "vitest";
import {
  STORES,
  getRecord,
  requestToPromise,
  runAtomicWrite,
} from "../../src/persistence/database";
import {
  T0,
  createHarness,
  createRecordingSession,
  makeDraftSystemActivityStep,
  makeEnvelope,
  stepId,
} from "../helpers/fixtures";
import { envelopeSourceKey } from "../../src/schemas/event-envelope";
import { sessionControlRecordSchema } from "../../src/schemas/session";
import { jsonUtf8ByteLength } from "../../src/shared/json-bytes";

describe("atomic write infrastructure", () => {
  it("commits all writes of a transaction together", async () => {
    const harness = await createHarness();
    await runAtomicWrite(harness.db, [STORES.settings], async (txn) => {
      txn.objectStore(STORES.settings).put({ key: "a", value: 1 });
      txn.objectStore(STORES.settings).put({ key: "b", value: 2 });
      return Promise.resolve();
    });
    const txn = harness.db.transaction([STORES.settings], "readonly");
    const all = await requestToPromise(txn.objectStore(STORES.settings).getAll());
    expect(all).toHaveLength(2);
  });

  it("rolls back ALL writes when the work callback fails mid-transaction", async () => {
    const harness = await createHarness();
    await expect(
      runAtomicWrite(harness.db, [STORES.settings], async (txn) => {
        txn.objectStore(STORES.settings).put({ key: "a", value: 1 });
        txn.objectStore(STORES.settings).put({ key: "b", value: 2 });
        await Promise.resolve();
        throw new Error("simulated failure between writes");
      }),
    ).rejects.toThrow("simulated failure between writes");

    const txn = harness.db.transaction([STORES.settings], "readonly");
    const all = await requestToPromise(txn.objectStore(STORES.settings).getAll());
    expect(all).toHaveLength(0); // nothing persisted — no partial commit
  });
});

describe("per-fact atomic commit (inbox + fact + indexes + counters + lastCommittedSeq)", () => {
  it("commits every companion record of one fact in one transaction", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);
    const step = makeDraftSystemActivityStep(session, stepId(1), 0);
    const envelope = makeEnvelope(session.sessionId, {
      kind: "step_draft_upsert",
      step,
    });

    const ack = await harness.ingestor.ingest(envelope);
    expect(ack.status).toBe("committed");

    // 1. Fact record present
    const stepsTxn = harness.db.transaction([STORES.steps], "readonly");
    const storedStep = await getRecord(stepsTxn.objectStore(STORES.steps), step.stepId);
    expect(storedStep).toMatchObject({ stepId: step.stepId, phase: "draft" });

    // 2. Durable inbox entry present with target linkage
    const inboxTxn = harness.db.transaction([STORES.inbox], "readonly");
    const inboxEntry = await getRecord(inboxTxn.objectStore(STORES.inbox), envelope.eventId);
    expect(inboxEntry).toMatchObject({
      eventId: envelope.eventId,
      targetStore: STORES.steps,
      targetKey: step.stepId,
      sourceSeq: envelope.sourceSeq,
    });

    // 3. Control record: lastCommittedSeq, counters, open-step index
    const control = await harness.sessions.getControl(session.sessionId);
    expect(control).not.toBeNull();
    if (control === null) {
      throw new Error("unreachable");
    }
    expect(control.lastCommittedSeqBySource[envelopeSourceKey(envelope)]).toBe(
      envelope.sourceSeq,
    );
    expect(control.lastCommittedEventId).toBe(envelope.eventId);
    expect(control.counters.factCount).toBe(1);
    expect(control.counters.totalLogicalBytes).toBe(jsonUtf8ByteLength(step));
    expect(control.counters.responseBodyLogicalBytes).toBe(0);
    expect(control.openStepIds).toContain(step.stepId);
  });

  it("sealing removes the step from openStepIds within the same commit", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);
    const draft = makeDraftSystemActivityStep(session, stepId(2), 0);
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "step_draft_upsert", step: draft }),
    );

    const sealed = {
      ...draft,
      phase: "sealed" as const,
      endedAt: T0 + 500,
      closeReason: "network_quiet" as const,
      domAfter: { captured: false as const, reason: "not_applicable_system_step" as const },
    };
    const { candidate: _candidate, ...sealedWithoutCandidate } = sealed;
    const ack = await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, {
        kind: "step_seal",
        step: sealedWithoutCandidate,
      }),
    );
    expect(ack.status).toBe("committed");

    const control = await harness.sessions.getControl(session.sessionId);
    expect(control?.openStepIds).not.toContain(draft.stepId);
  });

  it("rejects facts for a session without an open gate (no control record)", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);
    const foreign = makeEnvelope(session.sessionId, {
      kind: "step_draft_upsert",
      step: makeDraftSystemActivityStep(session, stepId(3), 0),
    });
    const bogusSession = { ...foreign, sessionId: sessionControlRecordSchema.shape.sessionId.parse("ses_missing") };
    const ack = await harness.ingestor.ingest(bogusSession);
    expect(ack).toMatchObject({ status: "rejected", errorCode: "SESSION_NOT_ACCEPTING_FACTS" });
  });
});
