import type { NavigationRecord, NavigationType, SystemNavigationTrigger } from "../schemas/navigation";
import { navigationRecordSchema } from "../schemas/navigation";
import { SCHEMA_VERSION } from "../schemas/common";
import type { StepScope } from "../schemas/step";
import type {
  CaptureEpochId,
  ExtDocumentId,
  NavigationRecordId,
  SessionId,
  StepId,
} from "../shared/ids";

export type NavigationSignal =
  | {
      kind: "history";
      action: "push" | "replace" | "hash_change";
    }
  | {
      kind: "web_navigation";
      navigationType: Exclude<NavigationType, "history_push" | "history_replace" | "hash_change">;
      redirectChain?: NavigationRecord["redirectChain"];
    };

export interface NavigationCommit {
  sessionId: SessionId;
  captureEpochId?: CaptureEpochId;
  scope: StepScope;
  beforeUrl: string;
  afterUrl: string;
  afterDocumentId: ExtDocumentId;
  title?: string;
  signal: NavigationSignal;
  committedAt: number;
  activeUserStepId?: StepId;
}

export type NavigationAttribution =
  | { kind: "existing_user_step"; stepId: StepId }
  | {
      kind: "new_system_step";
      stepId: StepId;
      trigger: SystemNavigationTrigger;
    };

export type DocumentTransition =
  | { kind: "same_document" }
  | {
      kind: "document_replaced";
      previousDocumentId: ExtDocumentId;
      nextDocumentId: ExtDocumentId;
    };

export interface SystemStepContext {
  sessionId: SessionId;
  captureEpochId: CaptureEpochId;
  scope: StepScope;
}

export interface NavigationDecision {
  navigation: NavigationRecord;
  attribution: NavigationAttribution;
  documentTransition: DocumentTransition;
  systemStepContext?: SystemStepContext;
}

export interface NavigationCoordinatorDependencies {
  newNavigationRecordId: () => NavigationRecordId;
  newSystemStepId: () => StepId;
}

/**
 * Maps already-validated extension navigation facts into the persisted
 * navigation contract. Browser evidence collection stays at the adapter
 * boundary; this class never guesses a source Step from timing or recency.
 */
export class NavigationCoordinator {
  constructor(private readonly dependencies: NavigationCoordinatorDependencies) {}

  record(input: NavigationCommit): NavigationDecision {
    const navigationType = toNavigationType(input.signal);
    const attribution =
      input.activeUserStepId === undefined
        ? this.systemAttribution(navigationType)
        : ({ kind: "existing_user_step", stepId: input.activeUserStepId } as const);

    const baseRecord = {
      schemaVersion: SCHEMA_VERSION,
      navigationRecordId: this.dependencies.newNavigationRecordId(),
      sessionId: input.sessionId,
      stepId: attribution.stepId,
      tabId: input.scope.tabId,
      frameId: input.scope.frameId,
      beforeUrl: input.beforeUrl,
      afterUrl: input.afterUrl,
      beforeDocumentId: input.scope.documentId,
      afterDocumentId: input.afterDocumentId,
      navigationType,
      redirectChain:
        input.signal.kind === "web_navigation" ? (input.signal.redirectChain ?? []) : [],
      committedAt: input.committedAt,
    };
    const navigation = navigationRecordSchema.parse(
      input.title === undefined ? baseRecord : { ...baseRecord, title: input.title },
    );

    const documentTransition: DocumentTransition =
      input.scope.documentId === input.afterDocumentId
        ? { kind: "same_document" }
        : {
            kind: "document_replaced",
            previousDocumentId: input.scope.documentId,
            nextDocumentId: input.afterDocumentId,
          };

    const baseDecision = { navigation, attribution, documentTransition };
    return attribution.kind === "new_system_step" && input.captureEpochId !== undefined
      ? {
          ...baseDecision,
          systemStepContext: {
            sessionId: input.sessionId,
            captureEpochId: input.captureEpochId,
            scope: {
              ...input.scope,
              documentId: input.afterDocumentId,
            },
          },
        }
      : baseDecision;
  }

  private systemAttribution(navigationType: NavigationType): NavigationAttribution {
    return {
      kind: "new_system_step",
      stepId: this.dependencies.newSystemStepId(),
      trigger: toSystemTrigger(navigationType),
    };
  }
}

const toNavigationType = (signal: NavigationSignal): NavigationType => {
  if (signal.kind === "web_navigation") {
    return signal.navigationType;
  }
  switch (signal.action) {
    case "push":
      return "history_push";
    case "replace":
      return "history_replace";
    case "hash_change":
      return "hash_change";
  }
};

const toSystemTrigger = (navigationType: NavigationType): SystemNavigationTrigger => {
  switch (navigationType) {
    case "reload":
      return "browser_reload";
    case "back_forward":
      return "browser_back_forward";
    case "redirect":
      return "auto_redirect";
    case "history_push":
    case "history_replace":
    case "hash_change":
      return "script_navigation";
    case "link":
    case "form_submit":
    case "other":
      return "unknown_no_evidence";
  }
};
