import type { SessionLifecycle } from "../schemas/session";

/**
 * Session lifecycle state machine (design 4).
 *
 * ```
 * idle -> starting -> recording -> stopping -> completed -> deleted
 * starting -> idle                      (permission denied / preflight failed)
 * recording -> interrupted              (runtime death detected on recovery)
 * interrupted -> recording | stopping
 * recording -> paused_storage_pressure
 * paused_storage_pressure -> recording | stopping
 * ```
 *
 * Transitions are pure; persistence + idempotency are handled by the caller
 * (session repository persists every transition; re-applying a transition
 * that already happened resolves to `unchanged`).
 */

export type SessionLifecycleEvent =
  | "start_requested"
  | "start_completed"
  | "start_aborted"
  | "stop_requested"
  | "stop_completed"
  | "runtime_interrupted"
  | "resume_after_interruption"
  | "storage_pressure_pause"
  | "explicit_resume_after_pressure"
  | "delete_requested";

const TRANSITIONS: Readonly<
  Record<SessionLifecycleEvent, Partial<Record<SessionLifecycle, SessionLifecycle>>>
> = {
  start_requested: { idle: "starting" },
  start_completed: { starting: "recording" },
  start_aborted: { starting: "idle" },
  stop_requested: {
    recording: "stopping",
    interrupted: "stopping",
    paused_storage_pressure: "stopping",
  },
  stop_completed: { stopping: "completed" },
  runtime_interrupted: {
    recording: "interrupted",
    starting: "interrupted",
    stopping: "interrupted",
  },
  resume_after_interruption: { interrupted: "recording" },
  storage_pressure_pause: { recording: "paused_storage_pressure" },
  explicit_resume_after_pressure: { paused_storage_pressure: "recording" },
  delete_requested: { completed: "deleted" },
};

export type TransitionResult =
  | { outcome: "transitioned"; next: SessionLifecycle }
  | { outcome: "unchanged"; state: SessionLifecycle }
  | { outcome: "invalid"; state: SessionLifecycle; event: SessionLifecycleEvent };

/**
 * Idempotency rule: if the current state already equals the target the event
 * would produce from ANY of its legal origins, re-application is `unchanged`.
 */
export const transition = (
  state: SessionLifecycle,
  event: SessionLifecycleEvent,
): TransitionResult => {
  const table = TRANSITIONS[event];
  const next = table[state];
  if (next !== undefined) {
    return { outcome: "transitioned", next };
  }
  const targets = new Set(Object.values(table));
  if (targets.has(state)) {
    return { outcome: "unchanged", state };
  }
  return { outcome: "invalid", state, event };
};

/** States in which the fact-intake gate is open. */
export const acceptsFacts = (state: SessionLifecycle): boolean =>
  state === "recording" || state === "starting" || state === "stopping";

/** States a startup-recovery pass treats as an unclean (interrupted) epoch. */
export const isUncleanActiveState = (state: SessionLifecycle): boolean =>
  state === "recording" || state === "starting" || state === "stopping";
