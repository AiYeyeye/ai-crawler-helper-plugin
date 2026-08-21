import type { SessionRepository } from "../persistence/session-repository";
import type { HandshakeResponse } from "../shared/messages";
import type { ContentObservationEnvelope } from "../schemas/content-observation";
import type { StepContext } from "../core/step-orchestrator";
import type { ContentObservationPayload } from "../schemas/content-observation";
import type { SessionLifecycle, SessionRecord } from "../schemas/session";
import {
  toExtDocumentId,
  toExtFrameId,
  toExtTabId,
} from "../shared/ids";

export interface ContentMessageSenderIdentity {
  tabId?: number;
  frameId?: number;
  documentId?: string;
  url?: string;
}

export type SessionContextRepository = Pick<
  SessionRepository,
  "listSessionsForTab" | "getControl"
>;

export const observationMatchesContentSessionContext = (
  observation: ContentObservationEnvelope,
  context: StepContext,
): boolean =>
  observation.sessionId === context.sessionId &&
  observation.captureEpochId === context.captureEpochId &&
  observation.scope.tabId === context.scope.tabId &&
  observation.scope.documentId === context.scope.documentId &&
  observation.scope.frameId === context.scope.frameId;

export type ContentObservationContextClassification = "current" | "stale" | "invalid";

export const classifyContentObservationContext = (
  observation: ContentObservationEnvelope,
  context: StepContext,
  issuedSessions: readonly Pick<SessionRecord, "sessionId" | "captureEpochIds">[],
): ContentObservationContextClassification => {
  const matchesBrowserScope =
    observation.scope.tabId === context.scope.tabId &&
    observation.scope.documentId === context.scope.documentId &&
    observation.scope.frameId === context.scope.frameId;
  if (!matchesBrowserScope) {
    return "invalid";
  }
  if (observationMatchesContentSessionContext(observation, context)) {
    return "current";
  }
  const wasIssued = issuedSessions.some(
    (session) =>
      session.sessionId === observation.sessionId &&
      session.captureEpochIds.includes(observation.captureEpochId),
  );
  return wasIssued ? "stale" : "invalid";
};

export const acceptsContentObservation = (
  lifecycle: SessionLifecycle,
  payload: ContentObservationPayload,
): boolean =>
  lifecycle !== "stopping" ||
  (payload.kind !== "action_started" && payload.kind !== "candidate_started");

/** Resolve an authenticated content-script scope from browser-owned sender data. */
export const resolveContentSessionContext = async (
  sessions: SessionContextRepository,
  sender: ContentMessageSenderIdentity,
  options: { readonly acceptStopping?: boolean } = {},
): Promise<HandshakeResponse> => {
  if (
    sender.tabId === undefined ||
    sender.frameId === undefined ||
    sender.documentId === undefined
  ) {
    return { active: false };
  }

  const tabId = toExtTabId(sender.tabId);
  const acceptsLifecycle = (lifecycle: SessionLifecycle): boolean =>
    lifecycle === "recording" ||
    (options.acceptStopping !== false && lifecycle === "stopping");
  const candidates = (await sessions.listSessionsForTab(tabId))
    .filter((session) => acceptsLifecycle(session.lifecycle))
    .sort((left, right) => right.startedAt - left.startedAt);

  for (const session of candidates) {
    const control = await sessions.getControl(session.sessionId);
    if (
      control === null ||
      !acceptsLifecycle(control.lifecycle)
    ) {
      continue;
    }
    return {
      active: true,
      sessionId: session.sessionId,
      captureEpochId: control.captureEpochId,
      scope: {
        tabId,
        frameId: toExtFrameId(sender.frameId),
        documentId: toExtDocumentId(sender.documentId),
      },
      config: session.config,
    };
  }

  return { active: false };
};
