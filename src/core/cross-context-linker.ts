import type {
  BrowserContextEvidence,
  ContextLinkage,
  ExplicitContextLink,
} from "../schemas/step";
import type { StepId } from "../shared/ids";

const buildVerifiedLink = (
  targetStepId: StepId,
  evidence: BrowserContextEvidence,
): ExplicitContextLink => {
  const shared = {
    sourceStepId: evidence.sourceStepId,
    targetStepId,
    evidenceId: evidence.evidenceId,
    confidence: "verified" as const,
  };
  switch (evidence.evidenceType) {
    case "created_navigation_target":
      return {
        ...shared,
        relationType: "triggered_by_step",
        evidenceType: "created_navigation_target",
      };
    case "confirmed_action_token":
      return {
        ...shared,
        relationType: "triggered_by_step",
        evidenceType: "confirmed_action_token",
      };
    case "parent_frame_navigation":
      return {
        ...shared,
        relationType: "triggered_by_step",
        evidenceType: "parent_frame_navigation",
      };
    case "opener_tab_id":
      return {
        ...shared,
        relationType: "opener_step",
        evidenceType: "opener_tab_id",
      };
  }
};

const evidenceIdentity = (evidence: BrowserContextEvidence): string =>
  `${evidence.evidenceType}\u0000${evidence.evidenceId}\u0000${String(evidence.sourceStepId)}`;

/**
 * Resolves cross-tab/frame linkage from browser-verifiable evidence only.
 *
 * The linker deliberately accepts no timestamp or "current step" input, so
 * recency and cross-tab global-current heuristics cannot influence a result.
 * `getLinksBySourceStepId` is a transient convenience cache. FactIngestor
 * persists the authoritative reverse projection on the source Step.
 */
export class CrossContextLinker {
  private readonly linksBySourceStepId = new Map<StepId, ExplicitContextLink[]>();

  resolve(
    targetStepId: StepId,
    evidence: readonly BrowserContextEvidence[],
  ): ContextLinkage {
    if (evidence.length === 0) {
      return {
        state: "unlinked",
        targetStepId,
        reason: "missing_browser_evidence",
      };
    }

    if (evidence.length > 1) {
      const identities = new Set(evidence.map(evidenceIdentity));
      return {
        state: "ambiguous",
        targetStepId,
        reason: identities.size === 1 ? "duplicate_evidence" : "conflicting_evidence",
        evidence: [...evidence],
      };
    }

    const uniqueEvidence = evidence[0];
    if (uniqueEvidence === undefined) {
      return {
        state: "unlinked",
        targetStepId,
        reason: "missing_browser_evidence",
      };
    }

    const link = buildVerifiedLink(targetStepId, uniqueEvidence);
    const sourceLinks = this.linksBySourceStepId.get(link.sourceStepId);
    if (sourceLinks === undefined) {
      this.linksBySourceStepId.set(link.sourceStepId, [link]);
    } else {
      sourceLinks.push(link);
    }

    return { state: "verified", link };
  }

  getLinksBySourceStepId(sourceStepId: StepId): ExplicitContextLink[] {
    return [...(this.linksBySourceStepId.get(sourceStepId) ?? [])];
  }
}
