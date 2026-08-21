import { NETWORK_QUIET_WINDOW_MS, STEP_MAX_WINDOW_MS } from "./config";
import type { ActionRecord, UserActionType } from "../schemas/action";
import { SCHEMA_VERSION } from "../schemas/common";
import type { DomAfter, DomCapture } from "../schemas/dom";
import {
  draftStepSchema,
  draftSystemActivityStepSchema,
  draftSystemNavigationStepSchema,
  draftUserActionStepSchema,
  sealedSystemActivityStepSchema,
  sealedSystemNavigationStepSchema,
  sealedUserActionStepSchema,
  type ContextLinkage,
  type DraftStep,
  type DraftSystemActivityStep,
  type DraftSystemNavigationStep,
  type DraftUserActionStep,
  type SealedStep,
  type StepScope,
} from "../schemas/step";
import type { NavigationRecord, SystemNavigationTrigger } from "../schemas/navigation";
import {
  newCandidateToken,
  newStepId,
  type CandidateToken,
  type CaptureEpochId,
  type DomRecordId,
  type SessionId,
  type StepId,
  type StorageRecordId,
} from "../shared/ids";

/** Cancels one task previously registered with the injected scheduler. */
export type CancelScheduledStepTask = () => void;

/** Browser-independent timer boundary; tests can inject a deterministic scheduler. */
export type ScheduleStepTask = (
  delayMs: number,
  run: () => void,
) => CancelScheduledStepTask;

export interface StepContext {
  sessionId: SessionId;
  captureEpochId: CaptureEpochId;
  scope: StepScope;
}

export interface StartUserActionInput {
  context: StepContext;
  action: ActionRecord;
  domBefore: DomCapture;
  candidate: boolean;
}

export interface StartCandidateInput {
  context: StepContext;
  candidateToken: CandidateToken;
  type: CandidateActionType;
  startedAt: number;
  domBefore: DomCapture;
}

export interface CompleteCandidateInput {
  context: StepContext;
  candidateToken: CandidateToken;
  action: ActionRecord;
}

export interface CancelCandidateInput {
  context: StepContext;
  candidateToken: CandidateToken;
  reason: CandidateDiscardReason;
}

export interface StartSystemNavigationInput {
  context: StepContext;
  stepId: StepId;
  trigger: SystemNavigationTrigger;
  navigation: NavigationRecord;
  contextLink?: ContextLinkage;
  startedAt: number;
}

export interface ObserveDomChangeInput {
  context: StepContext;
  domRecordId: DomRecordId;
  domAfter: DomAfter;
}

export interface ObserveStorageChangeInput {
  context: StepContext;
  storageDiffId: StorageRecordId;
}

export interface ObserveNetworkMessageInput {
  context: StepContext;
}

export interface RequestStartedInput {
  context: StepContext;
  requestKey: string;
}

export interface RequestFinishedInput {
  sessionId: SessionId;
  requestKey: string;
}

export type DraftUpdateReason =
  | "candidate_completed"
  | "candidate_promoted"
  | "request_started"
  | "dom_change"
  | "storage_change";

export type CandidateDiscardReason =
  | "pointer_leave"
  | "quiet_window"
  | "replaced_by_action"
  | "stopped"
  | "replaced_by_candidate"
  | "next_user_action"
  | "document_replaced"
  | "session_stopping"
  | "max_window_timeout";

export type StepLifecycleEvent =
  | { type: "draft_created"; step: DraftStep }
  | { type: "draft_updated"; step: DraftStep; reason: DraftUpdateReason }
  | { type: "step_sealed"; step: SealedStep }
  | { type: "candidate_discarded"; step: DraftStep; reason: CandidateDiscardReason };

export interface StepOrchestratorOptions {
  now?: () => number;
  schedule?: ScheduleStepTask;
  newStepId?: () => StepId;
  onEvent?: (event: StepLifecycleEvent) => void;
  quietWindowMs?: number;
  maxWindowMs?: number;
}

export interface SessionMaxOrdinal {
  sessionId: SessionId;
  maxOrdinal: number;
}

export interface HydratedInFlightRequest {
  context: StepContext;
  requestKey: string;
  startedInStepId: StepId;
}

export interface HydrateStepOrchestratorInput {
  openDraftSteps: readonly DraftStep[];
  sessionMaxOrdinals: readonly SessionMaxOrdinal[];
  inFlightRequests?: readonly HydratedInFlightRequest[];
}

interface LiveStep {
  draft: DraftStep;
  inFlightRequestKeys: Set<string>;
  domAfter: DomAfter | null;
  cancelQuiet: CancelScheduledStepTask | null;
  cancelMax: CancelScheduledStepTask | null;
  candidateToken: CandidateToken | null;
}

interface ScopeState {
  key: string;
  context: StepContext;
  active: LiveStep | null;
  candidate: LiveStep | null;
}

interface RequestAssignment {
  scopeKey: string;
  requestKey: string;
  startedInStepId: StepId;
}

interface CandidateBinding {
  scopeKey: string;
  live: LiveStep;
}

export type CandidateActionType = Extract<UserActionType, "input" | "hover" | "scroll">;

const defaultSchedule: ScheduleStepTask = (delayMs, run) => {
  const timer = setTimeout(run, delayMs);
  return () => {
    clearTimeout(timer);
  };
};

const appendUnique = (values: readonly string[], value: string): string[] =>
  values.includes(value) ? [...values] : [...values, value];

const isCandidateActionType = (type: UserActionType): type is CandidateActionType =>
  type === "input" || type === "hover" || type === "scroll";

/**
 * Pure in-memory Step window coordinator.
 *
 * It owns attribution and convergence only. Every durable write is delegated
 * to the caller through typed lifecycle events.
 */
export class StepOrchestrator {
  private readonly now: () => number;
  private readonly schedule: ScheduleStepTask;
  private readonly createStepId: () => StepId;
  private readonly onEvent: (event: StepLifecycleEvent) => void;
  private readonly quietWindowMs: number;
  private readonly maxWindowMs: number;
  private readonly scopes = new Map<string, ScopeState>();
  private readonly nextOrdinalBySession = new Map<SessionId, number>();
  private readonly requestAssignments = new Map<string, RequestAssignment>();
  private readonly candidateByToken = new Map<CandidateToken, CandidateBinding>();

  constructor(options: StepOrchestratorOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? defaultSchedule;
    this.createStepId = options.newStepId ?? newStepId;
    this.onEvent = options.onEvent ?? (() => undefined);
    this.quietWindowMs = options.quietWindowMs ?? NETWORK_QUIET_WINDOW_MS;
    this.maxWindowMs = options.maxWindowMs ?? STEP_MAX_WINDOW_MS;
    if (this.quietWindowMs < 0 || this.maxWindowMs < 0) {
      throw new Error("Step convergence windows must be non-negative");
    }
  }

  startUserAction(input: StartUserActionInput): DraftUserActionStep {
    if (input.candidate) {
      if (!isCandidateActionType(input.action.type)) {
        throw new Error(`action type ${input.action.type} cannot start as a candidate`);
      }
      const candidateToken = newCandidateToken();
      const candidate = this.startCandidate({
        context: input.context,
        candidateToken,
        type: input.action.type,
        startedAt: input.action.occurredAt,
        domBefore: input.domBefore,
      });
      const binding = this.candidateByToken.get(candidateToken);
      if (binding === undefined || binding.live.draft.stepId !== candidate.stepId) {
        throw new Error(`candidate ${candidateToken} was not registered`);
      }
      return draftUserActionStepSchema.parse(
        this.fillCandidateAction(binding.live, input.action),
      );
    }

    const state = this.scopeState(input.context);
    this.discardCandidate(state, "next_user_action");
    this.closeActive(state, "next_user_action");

    const draft = draftUserActionStepSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      stepId: this.createStepId(),
      sessionId: input.context.sessionId,
      captureEpochId: input.context.captureEpochId,
      scope: input.context.scope,
      ordinal: this.nextOrdinal(input.context.sessionId),
      startedAt: input.action.occurredAt,
      excluded: false,
      phase: "draft",
      candidate: false,
      requestKeys: [],
      storageDiffIds: [],
      domRecordIds: [],
      kind: "user_action",
      type: input.action.type,
      action: input.action,
      domBefore: input.domBefore,
    });
    const live = this.liveStep(draft);
    state.active = live;
    this.armActiveTimers(state, live);
    this.emitCreated(draft);
    return draftUserActionStepSchema.parse(draft);
  }

  startCandidate(input: StartCandidateInput): DraftUserActionStep {
    if (this.candidateByToken.has(input.candidateToken)) {
      throw new Error(`candidate token ${input.candidateToken} is already active`);
    }
    const previousState = this.scopeState(input.context);
    this.discardCandidate(previousState, "replaced_by_candidate");
    const state = this.scopeState(input.context);
    const draft = draftUserActionStepSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      stepId: this.createStepId(),
      sessionId: input.context.sessionId,
      captureEpochId: input.context.captureEpochId,
      scope: input.context.scope,
      ordinal: this.nextOrdinal(input.context.sessionId),
      startedAt: input.startedAt,
      excluded: false,
      phase: "draft",
      candidate: true,
      requestKeys: [],
      storageDiffIds: [],
      domRecordIds: [],
      kind: "user_action",
      type: input.type,
      domBefore: input.domBefore,
      candidateToken: input.candidateToken,
    });
    const live = this.liveStep(draft, input.candidateToken);
    state.candidate = live;
    this.candidateByToken.set(input.candidateToken, { scopeKey: state.key, live });
    this.armCandidateMaximum(state, live);
    this.emitCreated(draft);
    return draftUserActionStepSchema.parse(draft);
  }

  completeCandidate(input: CompleteCandidateInput): DraftUserActionStep {
    const completed = this.tryCompleteCandidate(input);
    if (completed === null) {
      throw new Error(`candidate ${input.candidateToken} is not active in the requested scope`);
    }
    return completed;
  }

  /** Boundary-safe terminal operation: late candidate results are idempotent. */
  tryCompleteCandidate(input: CompleteCandidateInput): DraftUserActionStep | null {
    const binding = this.candidateByToken.get(input.candidateToken);
    const state = this.scopes.get(this.scopeKey(input.context));
    if (
      binding === undefined ||
      state === undefined ||
      binding.scopeKey !== state.key ||
      state.candidate !== binding.live
    ) {
      return null;
    }
    this.fillCandidateAction(binding.live, input.action);
    return draftUserActionStepSchema.parse(this.promoteCandidate(state).draft);
  }

  cancelCandidate(input: CancelCandidateInput): boolean {
    const binding = this.candidateByToken.get(input.candidateToken);
    const state = this.scopes.get(this.scopeKey(input.context));
    if (
      binding === undefined ||
      state === undefined ||
      binding.scopeKey !== state.key ||
      state.candidate !== binding.live
    ) {
      return false;
    }
    this.discardCandidate(state, input.reason);
    return true;
  }

  activeStepId(context: StepContext): StepId | null {
    const state = this.scopes.get(this.scopeKey(context));
    return state?.active?.draft.stepId ?? state?.candidate?.draft.stepId ?? null;
  }

  activeUserStepId(context: StepContext): StepId | null {
    const state = this.scopes.get(this.scopeKey(context));
    const active = state?.active?.draft;
    return active?.kind === "user_action" ? active.stepId : null;
  }

  inFlightRequestKeys(context: StepContext): string[] {
    const scopeKey = this.scopeKey(context);
    return [...this.requestAssignments.values()]
      .filter((assignment) => assignment.scopeKey === scopeKey)
      .map((assignment) => assignment.requestKey)
      .sort((left, right) => left.localeCompare(right));
  }

  startSystemNavigation(input: StartSystemNavigationInput): DraftSystemNavigationStep {
    if (input.navigation.stepId !== input.stepId) {
      throw new Error("system-navigation Step id must match its navigation record");
    }
    const state = this.scopeState(input.context);
    this.discardCandidate(state, "next_user_action");
    this.closeActive(state, "navigation_started");
    const base = {
      schemaVersion: SCHEMA_VERSION,
      stepId: input.stepId,
      sessionId: input.context.sessionId,
      captureEpochId: input.context.captureEpochId,
      scope: input.context.scope,
      ordinal: this.nextOrdinal(input.context.sessionId),
      startedAt: input.startedAt,
      excluded: false,
      phase: "draft" as const,
      candidate: false,
      requestKeys: [],
      storageDiffIds: [],
      domRecordIds: [],
      kind: "system_navigation" as const,
      type: "system_navigation" as const,
      trigger: input.trigger,
      navigation: input.navigation,
    };
    const draft = draftSystemNavigationStepSchema.parse(
      input.contextLink === undefined ? base : { ...base, contextLink: input.contextLink },
    );
    const live = this.liveStep(draft);
    state.active = live;
    this.armActiveTimers(state, live);
    this.emitCreated(draft);
    return draft;
  }

  hydrate(input: HydrateStepOrchestratorInput): void {
    if (
      this.scopes.size > 0 ||
      this.requestAssignments.size > 0 ||
      this.candidateByToken.size > 0 ||
      this.nextOrdinalBySession.size > 0
    ) {
      throw new Error("StepOrchestrator can only hydrate into an empty instance");
    }

    for (const watermark of input.sessionMaxOrdinals) {
      if (!Number.isInteger(watermark.maxOrdinal) || watermark.maxOrdinal < 0) {
        throw new Error("session max ordinal must be a non-negative integer");
      }
      this.advanceOrdinal(watermark.sessionId, watermark.maxOrdinal + 1);
    }

    const drafts = input.openDraftSteps.map((step) => draftStepSchema.parse(step));
    for (const draft of drafts) {
      this.advanceOrdinal(draft.sessionId, draft.ordinal + 1);
    }
    for (const draft of drafts) {
      const context: StepContext = {
        sessionId: draft.sessionId,
        captureEpochId: draft.captureEpochId,
        scope: draft.scope,
      };
      const state = this.scopeState(context);
      if (draft.candidate) {
        if (draft.kind !== "user_action") {
          throw new Error(`only user-action drafts may hydrate as candidates: ${draft.stepId}`);
        }
        if (state.candidate !== null) {
          throw new Error(`multiple candidate drafts found for scope ${state.key}`);
        }
        if (this.candidateByToken.has(draft.candidateToken)) {
          throw new Error(`duplicate candidate token ${draft.candidateToken}`);
        }
        const live = this.liveStep(draft, draft.candidateToken);
        state.candidate = live;
        this.candidateByToken.set(draft.candidateToken, { scopeKey: state.key, live });
        this.armCandidateMaximum(state, live);
        continue;
      }
      if (state.active !== null) {
        throw new Error(`multiple active drafts found for scope ${state.key}`);
      }
      const live = this.liveStep(draft);
      state.active = live;
      this.armActiveTimers(state, live);
    }

    for (const request of input.inFlightRequests ?? []) {
      const assignmentKey = this.requestAssignmentKey(
        request.context.sessionId,
        request.requestKey,
      );
      const existing = this.requestAssignments.get(assignmentKey);
      if (
        existing !== undefined &&
        (existing.startedInStepId !== request.startedInStepId ||
          existing.scopeKey !== this.scopeKey(request.context))
      ) {
        throw new Error(`conflicting in-flight request projection ${request.requestKey}`);
      }
      const state = this.scopeState(request.context);
      this.requestAssignments.set(assignmentKey, {
        scopeKey: state.key,
        requestKey: request.requestKey,
        startedInStepId: request.startedInStepId,
      });
      const attributedLive =
        state.active?.draft.stepId === request.startedInStepId
          ? state.active
          : state.candidate?.draft.stepId === request.startedInStepId
            ? state.candidate
            : null;
      if (attributedLive !== null) {
        attributedLive.inFlightRequestKeys.add(request.requestKey);
        this.cancelQuietTimer(attributedLive);
      }
    }
  }

  observeDomChange(input: ObserveDomChangeInput): StepId {
    const state = this.scopeState(input.context);
    const live = this.resolveResultStep(state, "background_mutation");
    live.domAfter = input.domAfter;
    live.draft = this.parseManagedDraft({
      ...live.draft,
      domRecordIds: appendUnique(live.draft.domRecordIds, input.domRecordId),
    });
    this.emitUpdated(live.draft, "dom_change");
    this.rearmQuietAfterObservedFact(state, live);
    return live.draft.stepId;
  }

  observeStorageChange(input: ObserveStorageChangeInput): StepId {
    const state = this.scopeState(input.context);
    const live = state.active ?? this.createSystemActivity(state, "background_storage");
    live.draft = this.parseManagedDraft({
      ...live.draft,
      storageDiffIds: appendUnique(live.draft.storageDiffIds, input.storageDiffId),
    });
    this.emitUpdated(live.draft, "storage_change");
    this.rearmQuietAfterObservedFact(state, live);
    return live.draft.stepId;
  }

  observeNetworkMessage(input: ObserveNetworkMessageInput): StepId {
    const state = this.scopeState(input.context);
    const live = this.resolveResultStep(state, "background_network");
    this.rearmQuietAfterObservedFact(state, live);
    return live.draft.stepId;
  }

  requestStarted(input: RequestStartedInput): { startedInStepId: StepId } {
    const assignmentKey = this.requestAssignmentKey(input.context.sessionId, input.requestKey);
    const existing = this.requestAssignments.get(assignmentKey);
    if (existing !== undefined) {
      return { startedInStepId: existing.startedInStepId };
    }

    const state = this.scopeState(input.context);
    const live = this.resolveResultStep(state, "background_network");
    this.cancelQuietTimer(live);
    live.inFlightRequestKeys.add(input.requestKey);
    live.draft = this.parseManagedDraft({
      ...live.draft,
      requestKeys: appendUnique(live.draft.requestKeys, input.requestKey),
    });
    this.requestAssignments.set(assignmentKey, {
      scopeKey: state.key,
      requestKey: input.requestKey,
      startedInStepId: live.draft.stepId,
    });
    this.emitUpdated(live.draft, "request_started");
    return { startedInStepId: live.draft.stepId };
  }

  requestFinished(input: RequestFinishedInput): { startedInStepId: StepId } | null {
    const assignmentKey = this.requestAssignmentKey(input.sessionId, input.requestKey);
    const assignment = this.requestAssignments.get(assignmentKey);
    if (assignment === undefined) {
      return null;
    }
    this.requestAssignments.delete(assignmentKey);
    const state = this.scopes.get(assignment.scopeKey);
    const attributedLive =
      state?.active?.draft.stepId === assignment.startedInStepId
        ? state.active
        : state?.candidate?.draft.stepId === assignment.startedInStepId
          ? state.candidate
          : null;
    if (state !== undefined && attributedLive !== null) {
      attributedLive.inFlightRequestKeys.delete(input.requestKey);
      if (state.active === attributedLive && attributedLive.inFlightRequestKeys.size === 0) {
        this.armQuietTimer(state, attributedLive);
      }
    }
    return { startedInStepId: assignment.startedInStepId };
  }

  documentReplaced(context: StepContext): void {
    const state = this.scopes.get(this.scopeKey(context));
    if (state === undefined) {
      return;
    }
    this.closeActive(state, "document_replaced");
    this.discardCandidate(state, "document_replaced");
    this.cleanupScope(state);
  }

  sessionStopping(sessionId: SessionId): void {
    for (const state of [...this.scopes.values()]) {
      if (state.context.sessionId !== sessionId) {
        continue;
      }
      this.closeActive(state, "session_stopping");
      this.discardCandidate(state, "session_stopping");
      this.cleanupScope(state);
    }
  }

  /** Drop transient state after the durable fact gate has closed. */
  sessionPaused(sessionId: SessionId): void {
    const pausedScopeKeys = new Set<string>();
    for (const state of [...this.scopes.values()]) {
      if (state.context.sessionId !== sessionId) {
        continue;
      }
      pausedScopeKeys.add(state.key);
      if (state.active !== null) {
        this.cancelAllTimers(state.active);
        state.active = null;
      }
      if (state.candidate !== null) {
        this.cancelAllTimers(state.candidate);
        this.removeCandidateBinding(state.candidate);
        state.candidate = null;
      }
      this.scopes.delete(state.key);
    }
    for (const [key, assignment] of this.requestAssignments) {
      if (pausedScopeKeys.has(assignment.scopeKey)) {
        this.requestAssignments.delete(key);
      }
    }
  }

  private scopeState(context: StepContext): ScopeState {
    const key = this.scopeKey(context);
    const existing = this.scopes.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created: ScopeState = {
      key,
      context,
      active: null,
      candidate: null,
    };
    this.scopes.set(key, created);
    return created;
  }

  private createSystemActivity(
    state: ScopeState,
    trigger: DraftSystemActivityStep["trigger"],
  ): LiveStep {
    const draft = draftSystemActivityStepSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      stepId: this.createStepId(),
      sessionId: state.context.sessionId,
      captureEpochId: state.context.captureEpochId,
      scope: state.context.scope,
      ordinal: this.nextOrdinal(state.context.sessionId),
      startedAt: this.now(),
      excluded: false,
      phase: "draft",
      candidate: false,
      requestKeys: [],
      storageDiffIds: [],
      domRecordIds: [],
      kind: "system_activity",
      type: "system_activity",
      trigger,
      backgroundCandidate: true,
    });
    const live = this.liveStep(draft);
    state.active = live;
    this.armActiveTimers(state, live);
    this.emitCreated(draft);
    return live;
  }

  private resolveResultStep(
    state: ScopeState,
    backgroundTrigger: DraftSystemActivityStep["trigger"],
  ): LiveStep {
    const candidate = state.candidate;
    if (candidate !== null) {
      if (candidate.draft.kind !== "user_action") {
        throw new Error("candidate state must contain a user-action draft");
      }
      if (candidate.draft.action === undefined) {
        return candidate;
      }
      return this.promoteCandidate(state);
    }
    return state.active ?? this.createSystemActivity(state, backgroundTrigger);
  }

  private promoteCandidate(state: ScopeState): LiveStep {
    const candidate = state.candidate;
    if (
      candidate === null ||
      candidate.draft.kind !== "user_action" ||
      !candidate.draft.candidate
    ) {
      throw new Error("candidate promotion requires a user-action draft");
    }
    this.closeActive(state, "next_user_action");
    this.cancelAllTimers(candidate);
    this.removeCandidateBinding(candidate);
    const { candidateToken: _candidateToken, ...candidateDraft } = candidate.draft;
    candidate.draft = draftUserActionStepSchema.parse({
      ...candidateDraft,
      candidate: false,
    });
    state.candidate = null;
    state.active = candidate;
    this.armActiveTimers(state, candidate);
    this.emitUpdated(candidate.draft, "candidate_promoted");
    return candidate;
  }

  private liveStep(
    draft: DraftStep,
    candidateToken: CandidateToken | null = null,
  ): LiveStep {
    return {
      draft,
      inFlightRequestKeys: new Set<string>(),
      domAfter: null,
      cancelQuiet: null,
      cancelMax: null,
      candidateToken,
    };
  }

  private armActiveTimers(state: ScopeState, live: LiveStep): void {
    this.armMaximumTimer(state, live);
    if (live.inFlightRequestKeys.size === 0) {
      this.armQuietTimer(state, live);
    }
  }

  private armMaximumTimer(state: ScopeState, live: LiveStep): void {
    live.cancelMax?.();
    const elapsed = Math.max(0, this.now() - live.draft.startedAt);
    const remaining = Math.max(0, this.maxWindowMs - elapsed);
    live.cancelMax = this.schedule(remaining, () => {
      if (state.active === live) {
        this.closeActive(state, "max_window_timeout");
      }
    });
  }

  private armCandidateMaximum(state: ScopeState, live: LiveStep): void {
    const elapsed = Math.max(0, this.now() - live.draft.startedAt);
    const remaining = Math.max(0, this.maxWindowMs - elapsed);
    live.cancelMax = this.schedule(remaining, () => {
      if (state.candidate === live) {
        this.discardCandidate(state, "max_window_timeout");
      }
    });
  }

  private armQuietTimer(state: ScopeState, live: LiveStep): void {
    this.cancelQuietTimer(live);
    live.cancelQuiet = this.schedule(this.quietWindowMs, () => {
      if (state.active === live && live.inFlightRequestKeys.size === 0) {
        this.closeActive(state, "network_quiet");
      }
    });
  }

  private rearmQuietAfterObservedFact(state: ScopeState, live: LiveStep): void {
    if (state.active === live && live.inFlightRequestKeys.size === 0) {
      this.armQuietTimer(state, live);
    }
  }

  private closeActive(
    state: ScopeState,
    reason: SealedStep["closeReason"],
  ): SealedStep | null {
    const live = state.active;
    if (live === null) {
      return null;
    }
    this.cancelAllTimers(live);
    state.active = null;
    const sealed = this.seal(live, reason);
    this.onEvent({ type: "step_sealed", step: sealed });
    this.cleanupScope(state);
    return sealed;
  }

  private seal(live: LiveStep, reason: SealedStep["closeReason"]): SealedStep {
    const endedAt = this.now();
    const domAfter =
      reason === "document_replaced"
        ? ({ captured: false, reason: "document_replaced" } as const)
        : live.domAfter ??
          (live.draft.kind === "user_action"
            ? ({ captured: false, reason: "no_local_result" } as const)
            : ({ captured: false, reason: "not_applicable_system_step" } as const));

    if (live.draft.kind === "user_action") {
      const { phase: _phase, candidate: _candidate, ...draft } = live.draft;
      if (draft.action === undefined || draft.domBefore === undefined) {
        throw new Error(`cannot seal incomplete user-action step ${draft.stepId}`);
      }
      return sealedUserActionStepSchema.parse({
        ...draft,
        phase: "sealed",
        endedAt,
        closeReason: reason,
        domAfter,
      });
    }

    if (live.draft.kind === "system_navigation") {
      const { phase: _phase, candidate: _candidate, ...draft } = live.draft;
      if (draft.navigation === undefined) {
        throw new Error(`cannot seal incomplete system-navigation step ${draft.stepId}`);
      }
      return sealedSystemNavigationStepSchema.parse({
        ...draft,
        phase: "sealed",
        endedAt,
        closeReason: reason,
        domAfter,
      });
    }

    const { phase: _phase, candidate: _candidate, ...draft } = live.draft;
    return sealedSystemActivityStepSchema.parse({
      ...draft,
      phase: "sealed",
      endedAt,
      closeReason: reason,
      domAfter,
    });
  }

  private discardCandidate(state: ScopeState, reason: CandidateDiscardReason): void {
    const candidate = state.candidate;
    if (candidate === null) {
      return;
    }
    this.cancelAllTimers(candidate);
    this.removeCandidateBinding(candidate);
    state.candidate = null;
    this.onEvent({
      type: "candidate_discarded",
      step: draftStepSchema.parse(candidate.draft),
      reason,
    });
    this.cleanupScope(state);
  }

  private cancelQuietTimer(live: LiveStep): void {
    live.cancelQuiet?.();
    live.cancelQuiet = null;
  }

  private cancelAllTimers(live: LiveStep): void {
    this.cancelQuietTimer(live);
    live.cancelMax?.();
    live.cancelMax = null;
  }

  private emitCreated(step: DraftStep): void {
    this.onEvent({ type: "draft_created", step: draftStepSchema.parse(step) });
  }

  private emitUpdated(step: DraftStep, reason: DraftUpdateReason): void {
    this.onEvent({ type: "draft_updated", step: draftStepSchema.parse(step), reason });
  }

  private fillCandidateAction(live: LiveStep, action: ActionRecord): DraftUserActionStep {
    if (live.draft.kind !== "user_action") {
      throw new Error(`candidate ${live.draft.stepId} is not a user action`);
    }
    if (live.draft.type !== action.type) {
      throw new Error(
        `candidate action type mismatch: expected ${live.draft.type}, received ${action.type}`,
      );
    }
    live.draft = draftUserActionStepSchema.parse({
      ...live.draft,
      action,
    });
    this.emitUpdated(live.draft, "candidate_completed");
    return live.draft;
  }

  private removeCandidateBinding(live: LiveStep): void {
    if (live.candidateToken !== null) {
      const binding = this.candidateByToken.get(live.candidateToken);
      if (binding?.live === live) {
        this.candidateByToken.delete(live.candidateToken);
      }
      live.candidateToken = null;
    }
  }

  private parseManagedDraft(value: unknown): DraftStep {
    return draftStepSchema.parse(value);
  }

  private nextOrdinal(sessionId: SessionId): number {
    const ordinal = this.nextOrdinalBySession.get(sessionId) ?? 0;
    this.nextOrdinalBySession.set(sessionId, ordinal + 1);
    return ordinal;
  }

  private advanceOrdinal(sessionId: SessionId, nextOrdinal: number): void {
    const current = this.nextOrdinalBySession.get(sessionId) ?? 0;
    if (nextOrdinal > current) {
      this.nextOrdinalBySession.set(sessionId, nextOrdinal);
    }
  }

  private cleanupScope(state: ScopeState): void {
    if (state.active === null && state.candidate === null) {
      this.scopes.delete(state.key);
    }
  }

  private scopeKey(context: StepContext): string {
    return JSON.stringify([
      context.sessionId,
      context.captureEpochId,
      context.scope.tabId,
      context.scope.documentId,
      context.scope.frameId,
    ]);
  }

  private requestAssignmentKey(sessionId: SessionId, requestKey: string): string {
    return JSON.stringify([sessionId, requestKey]);
  }
}
