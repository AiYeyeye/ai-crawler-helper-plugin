import { describe, expect, it } from "vitest";
import { StepRepository } from "../../src/persistence/step-repository";
import { isSealedStep, type StoredStep } from "../../src/schemas/step";
import {
  createHarness,
  createRecordingSession,
  makeEnvelope,
  makeSealedUserActionStep,
  stepId,
  type TestHarness,
} from "../helpers/fixtures";
import type { SessionRecord } from "../../src/schemas/session";

/**
 * Gate 2 (subtask 06 / PRD 4.15): a review edit may only ever set `excluded`
 * or `note`. Every raw fact on the step must survive byte-identical, the step
 * must keep its id and phase, and exclusion must never delete anything.
 */

/** The step minus its two review fields — what must never change. */
const rawProjection = (step: StoredStep): string => {
  const { excluded: _excluded, note: _note, ...raw } = step;
  // Stable key order so the comparison is about values, not insertion order.
  return JSON.stringify(raw, Object.keys(raw).sort());
};

const seedStep = async (
  harness: TestHarness,
  session: SessionRecord,
): Promise<StoredStep> => {
  const step = makeSealedUserActionStep(session, stepId(90), 1, {
    locators: { ariaName: "结算", visibleText: "结算" },
    requestKeys: ["req-a", "req-b"],
    storageDiffIds: ["diff-a"],
  });
  const ack = await harness.ingestor.ingest(
    makeEnvelope(session.sessionId, { kind: "step_seal", step }),
  );
  expect(ack.status).not.toBe("rejected");
  const stored = await new StepRepository(harness.db).getStep(step.stepId);
  if (stored === null) {
    throw new Error("seeded step not persisted");
  }
  return stored;
};

const applyReview = async (
  harness: TestHarness,
  session: SessionRecord,
  update: { stepId: StoredStep["stepId"]; excluded?: boolean; note?: string | null },
): Promise<StoredStep> => {
  const ack = await harness.ingestor.ingest(
    makeEnvelope(session.sessionId, {
      kind: "step_review_update",
      stepId: update.stepId,
      ...(update.excluded === undefined ? {} : { excluded: update.excluded }),
      ...(update.note === undefined ? {} : { note: update.note }),
    }),
  );
  expect(ack.status).not.toBe("rejected");
  const stored = await new StepRepository(harness.db).getStep(update.stepId);
  if (stored === null) {
    throw new Error("step vanished after review update");
  }
  return stored;
};

describe("step review layer", () => {
  it("excluding a step leaves every raw fact byte-identical", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);
    const before = await seedStep(harness, session);
    const rawBefore = rawProjection(before);

    const after = await applyReview(harness, session, {
      stepId: before.stepId,
      excluded: true,
    });

    expect(after.excluded).toBe(true);
    expect(rawProjection(after)).toBe(rawBefore);
    expect(after.stepId).toBe(before.stepId);
    expect(after.ordinal).toBe(before.ordinal);
    expect(after.phase).toBe("sealed");
    expect(isSealedStep(after) && isSealedStep(before) ? after.requestKeys : []).toEqual(
      isSealedStep(before) ? before.requestKeys : [],
    );
  });

  it("does not physically delete an excluded step", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);
    const seeded = await seedStep(harness, session);

    await applyReview(harness, session, { stepId: seeded.stepId, excluded: true });

    const steps = await new StepRepository(harness.db).listStepsBySession(session.sessionId);
    expect(steps.map((step) => step.stepId)).toContain(seeded.stepId);
    expect(steps).toHaveLength(1);
  });

  it("restores a step without touching raw facts", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);
    const before = await seedStep(harness, session);
    const rawBefore = rawProjection(before);

    await applyReview(harness, session, { stepId: before.stepId, excluded: true });
    const restored = await applyReview(harness, session, {
      stepId: before.stepId,
      excluded: false,
    });

    expect(restored.excluded).toBe(false);
    expect(rawProjection(restored)).toBe(rawBefore);
  });

  it("sets and clears a note independently of exclusion", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);
    const before = await seedStep(harness, session);
    const rawBefore = rawProjection(before);

    const noted = await applyReview(harness, session, {
      stepId: before.stepId,
      note: "误点了一次，保留用于审计",
    });
    expect(noted.note).toBe("误点了一次，保留用于审计");
    expect(noted.excluded).toBe(false);
    expect(rawProjection(noted)).toBe(rawBefore);

    const cleared = await applyReview(harness, session, {
      stepId: before.stepId,
      note: null,
    });
    expect(cleared.note).toBeUndefined();
    expect(rawProjection(cleared)).toBe(rawBefore);
  });

  it("leaves the note untouched when only exclusion is sent", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);
    const before = await seedStep(harness, session);

    await applyReview(harness, session, { stepId: before.stepId, note: "保留" });
    const excluded = await applyReview(harness, session, {
      stepId: before.stepId,
      excluded: true,
    });

    expect(excluded.note).toBe("保留");
    expect(excluded.excluded).toBe(true);
  });

  it("survives a service-worker restart without losing the review layer", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);
    const before = await seedStep(harness, session);
    await applyReview(harness, session, {
      stepId: before.stepId,
      excluded: true,
      note: "重启后仍应保留",
    });

    const restarted = await harness.restart();
    const reloaded = await new StepRepository(restarted.db).getStep(before.stepId);

    expect(reloaded?.excluded).toBe(true);
    expect(reloaded?.note).toBe("重启后仍应保留");
    expect(reloaded === null ? "" : rawProjection(reloaded)).toBe(rawProjection(before));
  });
});
