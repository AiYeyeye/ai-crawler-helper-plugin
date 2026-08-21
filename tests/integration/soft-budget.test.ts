import { describe, expect, it } from "vitest";
import { STORES, getRecord, requestToPromise } from "../../src/persistence/database";
import { requestRecordSchema, responseBodyRecordSchema } from "../../src/schemas/network";
import { jsonUtf8ByteLength, utf8ByteLength } from "../../src/shared/json-bytes";
import {
  createHarness,
  createRecordingSession,
  makeDraftSystemActivityStep,
  makeEnvelope,
  makeRequestRecord,
  stepId,
} from "../helpers/fixtures";

describe("response-body soft budget (100 MiB default; bytes measured on actual UTF-8)", () => {
  it("includes captured response-body bytes in the session total logical byte counter", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness, {
      responseBodySoftBudgetBytes: 100,
    });
    const step = makeDraftSystemActivityStep(session, stepId(3), 0);
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "step_draft_upsert", step }),
    );
    const request = makeRequestRecord(session, step.stepId, 1);
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "request_metadata", record: request }),
    );

    const before = await harness.sessions.getControl(session.sessionId);
    const text = "青岛-to-Hamburg";
    const bodyRef = `${request.requestKey}#body`;
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, {
        kind: "response_body",
        requestKey: request.requestKey,
        bodyRef,
        text,
      }),
    );

    const txn = harness.db.transaction([STORES.responseBodies], "readonly");
    const storedBody = responseBodyRecordSchema.parse(
      await getRecord(txn.objectStore(STORES.responseBodies), bodyRef),
    );
    const after = await harness.sessions.getControl(session.sessionId);

    expect(after?.counters.totalLogicalBytes).toBe(
      (before?.counters.totalLogicalBytes ?? 0) + jsonUtf8ByteLength(storedBody),
    );
  });

  it("pauses ONLY new response bodies once the budget is exhausted; all other facts continue", async () => {
    const harness = await createHarness();
    // Tiny budget so the second body crosses it.
    const session = await createRecordingSession(harness, {
      responseBodySoftBudgetBytes: 100,
    });
    const step = makeDraftSystemActivityStep(session, stepId(1), 0);
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "step_draft_upsert", step }),
    );

    const requestA = makeRequestRecord(session, step.stepId, 1);
    const requestB = makeRequestRecord(session, step.stepId, 2);
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "request_metadata", record: requestA }),
    );
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "request_metadata", record: requestB }),
    );

    // Body A: 80 bytes — within budget, stored.
    const bodyA = "a".repeat(80);
    const ackA = await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, {
        kind: "response_body",
        requestKey: requestA.requestKey,
        bodyRef: `${requestA.requestKey}#body`,
        text: bodyA,
      }),
    );
    expect(ackA.status).toBe("committed");

    // Body B: 80 more bytes — would exceed 100; omitted with explicit reason.
    const bodyB = "b".repeat(80);
    const ackB = await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, {
        kind: "response_body",
        requestKey: requestB.requestKey,
        bodyRef: `${requestB.requestKey}#body`,
        text: bodyB,
      }),
    );
    expect(ackB.status).toBe("committed"); // the FACT commits; only the body is withheld

    const txn = harness.db.transaction([STORES.responseBodies, STORES.requests], "readonly");
    const bodies = await requestToPromise(txn.objectStore(STORES.responseBodies).getAll());
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ requestKey: requestA.requestKey });

    const storedA = requestRecordSchema.parse(
      await getRecord(txn.objectStore(STORES.requests), requestA.requestKey),
    );
    expect(storedA.responseBody).toMatchObject({ kind: "captured" });

    const storedB = requestRecordSchema.parse(
      await getRecord(txn.objectStore(STORES.requests), requestB.requestKey),
    );
    // Explicit omission marker — never an empty string / fake success.
    expect(storedB.responseBody).toEqual({
      kind: "unavailable",
      reason: "session_body_soft_budget_reached",
    });

    // Core recording continues after the budget hit: a further metadata fact commits.
    const requestC = makeRequestRecord(session, step.stepId, 3);
    const ackC = await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "request_metadata", record: requestC }),
    );
    expect(ackC.status).toBe("committed");

    // Counters: only body A charged to the body budget.
    const control = await harness.sessions.getControl(session.sessionId);
    expect(control?.counters.responseBodyLogicalBytes).toBe(utf8ByteLength(bodyA));

    // Session stays in recording — the soft budget never pauses the session.
    const refreshed = await harness.sessions.getSession(session.sessionId);
    expect(refreshed?.lifecycle).toBe("recording");
  });

  it("measures the budget in UTF-8 bytes, not JS string length", async () => {
    const harness = await createHarness();
    // Budget 20 bytes. "青岛到汉堡汉堡" = 7 chars but 21 UTF-8 bytes -> over budget.
    const session = await createRecordingSession(harness, {
      responseBodySoftBudgetBytes: 20,
    });
    const step = makeDraftSystemActivityStep(session, stepId(2), 0);
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "step_draft_upsert", step }),
    );
    const request = makeRequestRecord(session, step.stepId, 1);
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "request_metadata", record: request }),
    );

    const cjkBody = "青岛到汉堡汉堡";
    expect(cjkBody.length).toBeLessThan(20); // length check would wrongly admit
    expect(utf8ByteLength(cjkBody)).toBeGreaterThan(20);

    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, {
        kind: "response_body",
        requestKey: request.requestKey,
        bodyRef: `${request.requestKey}#body`,
        text: cjkBody,
      }),
    );

    const txn = harness.db.transaction([STORES.responseBodies], "readonly");
    const bodies = await requestToPromise(txn.objectStore(STORES.responseBodies).getAll());
    expect(bodies).toHaveLength(0); // correctly rejected on byte measurement
  });
});
