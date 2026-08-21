import { describe, expect, it } from "vitest";
import { STORES, requestToPromise } from "../../src/persistence/database";
import {
  createHarness,
  createRecordingSession,
  makeDraftSystemActivityStep,
  makeEnvelope,
  stepId,
} from "../helpers/fixtures";

describe("duplicate-message replay idempotency", () => {
  it("replaying the same envelope produces exactly one record and a duplicate ACK", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);
    const step = makeDraftSystemActivityStep(session, stepId(1), 0);
    const envelope = makeEnvelope(session.sessionId, { kind: "step_draft_upsert", step });

    const first = await harness.ingestor.ingest(envelope);
    expect(first.status).toBe("committed");

    const second = await harness.ingestor.ingest(envelope);
    expect(second.status).toBe("duplicate");

    const third = await harness.ingestor.ingest(envelope);
    expect(third.status).toBe("duplicate");

    const txn = harness.db.transaction([STORES.steps, STORES.inbox], "readonly");
    const steps = await requestToPromise(txn.objectStore(STORES.steps).getAll());
    const inbox = await requestToPromise(txn.objectStore(STORES.inbox).getAll());
    expect(steps).toHaveLength(1);
    expect(inbox).toHaveLength(1);
  });

  it("replay does not double-count byte counters or factCount", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);
    const step = makeDraftSystemActivityStep(session, stepId(2), 0);
    const envelope = makeEnvelope(session.sessionId, { kind: "step_draft_upsert", step });

    await harness.ingestor.ingest(envelope);
    const controlAfterFirst = await harness.sessions.getControl(session.sessionId);

    await harness.ingestor.ingest(envelope);
    const controlAfterReplay = await harness.sessions.getControl(session.sessionId);

    expect(controlAfterReplay?.counters).toEqual(controlAfterFirst?.counters);
    expect(controlAfterReplay?.lastCommittedEventId).toBe(
      controlAfterFirst?.lastCommittedEventId,
    );
  });

  it("replay across a service-worker restart is still deduplicated (durable inbox)", async () => {
    let harness = await createHarness();
    const session = await createRecordingSession(harness);
    const step = makeDraftSystemActivityStep(session, stepId(3), 0);
    const envelope = makeEnvelope(session.sessionId, { kind: "step_draft_upsert", step });

    const first = await harness.ingestor.ingest(envelope);
    expect(first.status).toBe("committed");

    // Simulate SW death + restart: fresh instances over the same database.
    harness = await harness.restart();

    // The session was marked interrupted by recovery-less restart? No —
    // recovery is a separate explicit pass; the gate is still open here, so
    // the replayed envelope hits the durable inbox and resolves duplicate.
    const replay = await harness.ingestor.ingest(envelope);
    expect(replay.status).toBe("duplicate");

    const txn = harness.db.transaction([STORES.steps], "readonly");
    const steps = await requestToPromise(txn.objectStore(STORES.steps).getAll());
    expect(steps).toHaveLength(1);
  });
});
