import { describe, expect, it } from "vitest";
import {
  acceptsFacts,
  isUncleanActiveState,
  transition,
} from "../../src/core/session-state-machine";
import type { SessionLifecycle } from "../../src/schemas/session";

describe("session state machine", () => {
  it("follows the happy path idle -> starting -> recording -> stopping -> completed -> deleted", () => {
    expect(transition("idle", "start_requested")).toEqual({
      outcome: "transitioned",
      next: "starting",
    });
    expect(transition("starting", "start_completed")).toEqual({
      outcome: "transitioned",
      next: "recording",
    });
    expect(transition("recording", "stop_requested")).toEqual({
      outcome: "transitioned",
      next: "stopping",
    });
    expect(transition("stopping", "stop_completed")).toEqual({
      outcome: "transitioned",
      next: "completed",
    });
    expect(transition("completed", "delete_requested")).toEqual({
      outcome: "transitioned",
      next: "deleted",
    });
  });

  it("aborts starting back to idle on permission denial", () => {
    expect(transition("starting", "start_aborted")).toEqual({
      outcome: "transitioned",
      next: "idle",
    });
  });

  it("supports interruption and both recovery directions", () => {
    expect(transition("recording", "runtime_interrupted")).toEqual({
      outcome: "transitioned",
      next: "interrupted",
    });
    expect(transition("interrupted", "resume_after_interruption")).toEqual({
      outcome: "transitioned",
      next: "recording",
    });
    expect(transition("interrupted", "stop_requested")).toEqual({
      outcome: "transitioned",
      next: "stopping",
    });
  });

  it("supports storage-pressure pause and explicit resume", () => {
    expect(transition("recording", "storage_pressure_pause")).toEqual({
      outcome: "transitioned",
      next: "paused_storage_pressure",
    });
    expect(transition("paused_storage_pressure", "explicit_resume_after_pressure")).toEqual({
      outcome: "transitioned",
      next: "recording",
    });
    expect(transition("paused_storage_pressure", "stop_requested")).toEqual({
      outcome: "transitioned",
      next: "stopping",
    });
  });

  it("is idempotent: re-applying an event whose target is the current state is unchanged", () => {
    expect(transition("recording", "start_completed")).toEqual({
      outcome: "unchanged",
      state: "recording",
    });
    expect(transition("paused_storage_pressure", "storage_pressure_pause")).toEqual({
      outcome: "unchanged",
      state: "paused_storage_pressure",
    });
    expect(transition("interrupted", "runtime_interrupted")).toEqual({
      outcome: "unchanged",
      state: "interrupted",
    });
  });

  it("rejects invalid transitions", () => {
    expect(transition("idle", "stop_requested").outcome).toBe("invalid");
    expect(transition("completed", "start_requested").outcome).toBe("invalid");
    expect(transition("idle", "explicit_resume_after_pressure").outcome).toBe("invalid");
    expect(transition("deleted", "start_requested").outcome).toBe("invalid");
  });

  it("treats re-applied resume as idempotent (already recording)", () => {
    expect(transition("recording", "explicit_resume_after_pressure")).toEqual({
      outcome: "unchanged",
      state: "recording",
    });
  });

  it("gates fact intake to active states only", () => {
    const accepting: SessionLifecycle[] = ["recording", "starting", "stopping"];
    const rejecting: SessionLifecycle[] = [
      "idle",
      "completed",
      "interrupted",
      "paused_storage_pressure",
      "deleted",
    ];
    for (const state of accepting) {
      expect(acceptsFacts(state)).toBe(true);
    }
    for (const state of rejecting) {
      expect(acceptsFacts(state)).toBe(false);
    }
  });

  it("classifies unclean active states for startup recovery", () => {
    expect(isUncleanActiveState("recording")).toBe(true);
    expect(isUncleanActiveState("starting")).toBe(true);
    expect(isUncleanActiveState("stopping")).toBe(true);
    expect(isUncleanActiveState("paused_storage_pressure")).toBe(false);
    expect(isUncleanActiveState("completed")).toBe(false);
  });
});
