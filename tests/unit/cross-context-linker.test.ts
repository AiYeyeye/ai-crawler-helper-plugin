import { describe, expect, it } from "vitest";
import { CrossContextLinker } from "../../src/core/cross-context-linker";
import type { BrowserContextEvidence } from "../../src/schemas/step";
import { stepId } from "../helpers/fixtures";

const evidence = (
  evidenceType: BrowserContextEvidence["evidenceType"],
  evidenceId: string,
  sourceStepId = stepId(1),
): BrowserContextEvidence => ({ evidenceType, evidenceId, sourceStepId });

describe("CrossContextLinker", () => {
  it.each([
    ["created_navigation_target", "triggered_by_step"],
    ["opener_tab_id", "opener_step"],
    ["confirmed_action_token", "triggered_by_step"],
    ["parent_frame_navigation", "triggered_by_step"],
  ] as const)(
    "creates a verified link from unique %s browser evidence",
    (evidenceType, relationType) => {
      const linker = new CrossContextLinker();
      const sourceStepId = stepId(1);
      const targetStepId = stepId(2);

      expect(
        linker.resolve(targetStepId, [evidence(evidenceType, "browser-event-1", sourceStepId)]),
      ).toEqual({
        state: "verified",
        link: {
          sourceStepId,
          targetStepId,
          relationType,
          evidenceType,
          evidenceId: "browser-event-1",
          confidence: "verified",
        },
      });
    },
  );

  it("returns ambiguous for duplicated evidence and does not index a link", () => {
    const linker = new CrossContextLinker();
    const sourceStepId = stepId(3);
    const targetStepId = stepId(4);
    const duplicated = evidence("opener_tab_id", "opener-1", sourceStepId);

    expect(linker.resolve(targetStepId, [duplicated, duplicated])).toEqual({
      state: "ambiguous",
      targetStepId,
      reason: "duplicate_evidence",
      evidence: [duplicated, duplicated],
    });
    expect(linker.getLinksBySourceStepId(sourceStepId)).toEqual([]);
  });

  it("returns ambiguous for conflicting evidence and does not choose a recent source", () => {
    const linker = new CrossContextLinker();
    const first = evidence("created_navigation_target", "target-created-1", stepId(5));
    const second = evidence("confirmed_action_token", "action-token-1", stepId(6));
    const targetStepId = stepId(7);

    expect(linker.resolve(targetStepId, [first, second])).toEqual({
      state: "ambiguous",
      targetStepId,
      reason: "conflicting_evidence",
      evidence: [first, second],
    });
    expect(linker.getLinksBySourceStepId(first.sourceStepId)).toEqual([]);
    expect(linker.getLinksBySourceStepId(second.sourceStepId)).toEqual([]);
  });

  it("returns an unlinked linkage gap when browser evidence is missing", () => {
    const linker = new CrossContextLinker();
    const targetStepId = stepId(8);

    expect(linker.resolve(targetStepId, [])).toEqual({
      state: "unlinked",
      targetStepId,
      reason: "missing_browser_evidence",
    });
  });

  it("indexes verified target links by sourceStepId and returns defensive copies", () => {
    const linker = new CrossContextLinker();
    const sourceStepId = stepId(9);
    const otherSourceStepId = stepId(10);
    const firstTargetStepId = stepId(11);
    const secondTargetStepId = stepId(12);

    linker.resolve(firstTargetStepId, [
      evidence("created_navigation_target", "target-created-1", sourceStepId),
    ]);
    linker.resolve(secondTargetStepId, [
      evidence("opener_tab_id", "opener-1", sourceStepId),
    ]);

    const links = linker.getLinksBySourceStepId(sourceStepId);
    expect(links.map((link) => link.targetStepId)).toEqual([
      firstTargetStepId,
      secondTargetStepId,
    ]);
    expect(linker.getLinksBySourceStepId(otherSourceStepId)).toEqual([]);
    links.length = 0;
    expect(linker.getLinksBySourceStepId(sourceStepId)).toHaveLength(2);
  });
});
