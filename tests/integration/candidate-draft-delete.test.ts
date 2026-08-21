import { describe, expect, it } from "vitest";
import { STORES, getRecord } from "../../src/persistence/database";
import { SCHEMA_VERSION } from "../../src/schemas/common";
import { draftUserActionStepSchema } from "../../src/schemas/step";
import {
  candidateTokenSchema,
  type CandidateToken,
  type StepId,
} from "../../src/shared/ids";
import type { SessionRecord } from "../../src/schemas/session";
import {
  T0,
  createHarness,
  createRecordingSession,
  makeEnvelope,
  stepId,
} from "../helpers/fixtures";

const makeUserActionDraft = (
  session: SessionRecord,
  id: StepId,
  candidate:
    | { candidate: true; candidateToken: CandidateToken }
    | { candidate: false },
) => {
  const captureEpochId = session.captureEpochIds.at(-1);
  if (captureEpochId === undefined) {
    throw new Error("session has no capture epoch");
  }
  return draftUserActionStepSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    stepId: id,
    sessionId: session.sessionId,
    captureEpochId,
    scope: {
      tabId: session.rootTabId,
      documentId: "doc-candidate",
      frameId: 0,
    },
    ordinal: 0,
    startedAt: T0,
    excluded: false,
    phase: "draft" as const,
    ...candidate,
    requestKeys: [],
    storageDiffIds: [],
    domRecordIds: [],
    kind: "user_action" as const,
    type: "hover" as const,
  });
};

describe("candidate draft deletion", () => {
  it("atomically deletes only a token-matching candidate and updates inbox/openStepIds", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);
    const id = stepId(101);
    const candidateToken = candidateTokenSchema.parse("can_matching");
    const draft = makeUserActionDraft(session, id, { candidate: true, candidateToken });
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "step_draft_upsert", step: draft }),
    );

    const deletion = makeEnvelope(session.sessionId, {
      kind: "step_draft_delete",
      stepId: id,
      candidateToken,
    });
    const ack = await harness.ingestor.ingest(deletion);

    expect(ack.status).toBe("committed");
    const txn = harness.db.transaction([STORES.steps, STORES.inbox], "readonly");
    expect(await getRecord(txn.objectStore(STORES.steps), id)).toBeUndefined();
    expect(await getRecord(txn.objectStore(STORES.inbox), deletion.eventId)).toMatchObject({
      eventId: deletion.eventId,
      targetStore: STORES.steps,
      targetKey: id,
    });
    expect((await harness.sessions.getControl(session.sessionId))?.openStepIds).not.toContain(id);
  });

  it("commits a stale token mismatch without deleting the draft or open-step index", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);
    const id = stepId(102);
    const persistedToken = candidateTokenSchema.parse("can_persisted");
    const staleToken = candidateTokenSchema.parse("can_stale");
    const draft = makeUserActionDraft(session, id, {
      candidate: true,
      candidateToken: persistedToken,
    });
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "step_draft_upsert", step: draft }),
    );

    const deletion = makeEnvelope(session.sessionId, {
      kind: "step_draft_delete",
      stepId: id,
      candidateToken: staleToken,
    });
    expect((await harness.ingestor.ingest(deletion)).status).toBe("committed");

    const txn = harness.db.transaction([STORES.steps, STORES.inbox], "readonly");
    expect(await getRecord(txn.objectStore(STORES.steps), id)).toMatchObject({
      stepId: id,
      candidate: true,
      candidateToken: persistedToken,
    });
    expect(await getRecord(txn.objectStore(STORES.inbox), deletion.eventId)).toBeDefined();
    expect((await harness.sessions.getControl(session.sessionId))?.openStepIds).toContain(id);
  });

  it("never deletes a promoted non-candidate draft even when the old token is replayed", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);
    const id = stepId(103);
    const oldToken = candidateTokenSchema.parse("can_promoted");
    const draft = makeUserActionDraft(session, id, { candidate: false });
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "step_draft_upsert", step: draft }),
    );

    const deletion = makeEnvelope(session.sessionId, {
      kind: "step_draft_delete",
      stepId: id,
      candidateToken: oldToken,
    });
    expect((await harness.ingestor.ingest(deletion)).status).toBe("committed");

    const txn = harness.db.transaction([STORES.steps], "readonly");
    expect(await getRecord(txn.objectStore(STORES.steps), id)).toMatchObject({
      stepId: id,
      candidate: false,
    });
    expect((await harness.sessions.getControl(session.sessionId))?.openStepIds).toContain(id);
  });

  it("deduplicates a replayed delete event without changing counters twice", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);
    const id = stepId(104);
    const candidateToken = candidateTokenSchema.parse("can_replay");
    const draft = makeUserActionDraft(session, id, { candidate: true, candidateToken });
    await harness.ingestor.ingest(
      makeEnvelope(session.sessionId, { kind: "step_draft_upsert", step: draft }),
    );
    const deletion = makeEnvelope(session.sessionId, {
      kind: "step_draft_delete",
      stepId: id,
      candidateToken,
    });

    expect((await harness.ingestor.ingest(deletion)).status).toBe("committed");
    const afterFirst = await harness.sessions.getControl(session.sessionId);
    expect((await harness.ingestor.ingest(deletion)).status).toBe("duplicate");
    const afterReplay = await harness.sessions.getControl(session.sessionId);

    expect(afterReplay?.counters).toEqual(afterFirst?.counters);
    expect(afterReplay?.lastCommittedEventId).toBe(afterFirst?.lastCommittedEventId);
  });
});
