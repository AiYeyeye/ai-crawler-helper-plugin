import { describe, expect, it } from "vitest";
import {
  FACT_SUMMARY_TEMPLATE_VERSION,
  buildFactSummary,
  renderFactSummary,
  statusCodeHistogram,
  targetLabel,
  type FactSummaryInput,
} from "../../src/core/fact-summary";
import { sealedUserActionStepSchema, type SealedUserActionStep } from "../../src/schemas/step";
import {
  T0,
  makeLocators,
  makeSealedUserActionStep,
  makeSessionRecord,
  stepId,
} from "../helpers/fixtures";

/**
 * Gate 1 (subtask 06): the fact summary must be byte-identical for the same
 * step + template version, and every emitted field must name the raw record
 * path it was read from.
 */

const record = makeSessionRecord();

/** Re-parse through the schema with a different key insertion order. */
const reorderKeys = (step: SealedUserActionStep): SealedUserActionStep => {
  const entries = Object.entries(step).reverse();
  return sealedUserActionStepSchema.parse(Object.fromEntries(entries));
};

describe("fact summary determinism", () => {
  it("produces byte-identical JSON and text for the same step", () => {
    const step = makeSealedUserActionStep(record, stepId(1), 1, {
      locators: { ariaName: "提交订单", visibleText: "提交", id: "submit" },
      requestKeys: ["k1", "k2"],
    });
    const input: FactSummaryInput = {
      step,
      requests: [
        { requestKey: "k1", statusCode: 200 },
        { requestKey: "k2", statusCode: 404 },
      ],
    };

    const first = buildFactSummary(input);
    const second = buildFactSummary(input);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(renderFactSummary(first)).toBe(renderFactSummary(second));
    expect(first.templateVersion).toBe(FACT_SUMMARY_TEMPLATE_VERSION);
  });

  it("is independent of object key insertion order", () => {
    const step = makeSealedUserActionStep(record, stepId(2), 2, {
      locators: { ariaName: "提交订单" },
      requestKeys: ["k1"],
    });
    const requests = [{ requestKey: "k1", statusCode: 200 }];

    const fromOriginal = renderFactSummary(buildFactSummary({ step, requests }));
    const fromReordered = renderFactSummary(
      buildFactSummary({ step: reorderKeys(step), requests }),
    );

    expect(fromReordered).toBe(fromOriginal);
  });

  it("normalizes whitespace so captured text cannot vary the output", () => {
    const messy = targetLabel(makeLocators({ ariaName: "  提交\n\t 订单  " }));
    const clean = targetLabel(makeLocators({ ariaName: "提交 订单" }));
    expect(messy.value).toBe(clean.value);
  });

  it("orders the status histogram numerically and reports missing statuses", () => {
    const histogram = statusCodeHistogram([
      { requestKey: "a", statusCode: 404 },
      { requestKey: "b", statusCode: 200 },
      { requestKey: "c", statusCode: 200 },
      { requestKey: "d" },
    ]);
    expect(histogram).toBe("200×2, 404×1, no_status×1");
  });

  it("keeps the target-label priority chain frozen", () => {
    const all = makeLocators({
      ariaName: "aria",
      visibleText: "text",
      id: "the-id",
      name: "the-name",
    });
    expect(targetLabel(all)).toEqual({ value: "aria", source: "locators.ariaName" });
    expect(targetLabel({ ...all, ariaName: undefined })).toEqual({
      value: "text",
      source: "locators.visibleText",
    });
    expect(targetLabel({ ...all, ariaName: undefined, visibleText: undefined })).toEqual({
      value: "the-id",
      source: "locators.id",
    });
    expect(
      targetLabel({ ...all, ariaName: undefined, visibleText: undefined, id: undefined }),
    ).toEqual({ value: "the-name", source: "locators.name" });
    expect(
      targetLabel(makeLocators({ cssSelector: "#only" })),
    ).toEqual({ value: "#only", source: "locators.cssSelector" });
  });
});

describe("fact summary traceability", () => {
  it("resolves every field source to a value present in the raw records", () => {
    const step = makeSealedUserActionStep(record, stepId(3), 3, {
      locators: { ariaName: "提交订单" },
      requestKeys: ["k1"],
      storageDiffIds: ["sd1"],
    });
    const summary = buildFactSummary({
      step,
      requests: [{ requestKey: "k1", statusCode: 201 }],
    });

    expect(summary.fields.length).toBeGreaterThan(0);
    for (const field of summary.fields) {
      expect(field.source).not.toBe("");
      // Every source names either the step record or the request projection.
      expect(field.source.startsWith("step.") || field.source.startsWith("requests[]")).toBe(
        true,
      );
    }

    const byLabel = new Map(summary.fields.map((field) => [field.label, field]));
    expect(byLabel.get("Requests")?.value).toBe(String(step.requestKeys.length));
    expect(byLabel.get("Storage diff records")?.value).toBe(String(step.storageDiffIds.length));
    expect(byLabel.get("Close reason")?.value).toBe(step.closeReason);
    expect(byLabel.get("Duration (ms)")?.value).toBe(String(step.endedAt - step.startedAt));
    expect(byLabel.get("Target")?.source).toBe("step.domBefore.locators.ariaName");
    expect(byLabel.get("Status codes")?.value).toBe("201×1");
    expect(summary.headline).toContain("click");
  });

  it("reports an uncaptured DOM as an explicit reason, never as zero changes", () => {
    const base = makeSealedUserActionStep(record, stepId(4), 4);
    const step = sealedUserActionStepSchema.parse({
      ...base,
      domAfter: { captured: false, reason: "missing_due_to_gap" },
    });

    const field = buildFactSummary({ step }).fields.find(
      (candidate) => candidate.label === "DOM changes",
    );
    expect(field?.value).toBe("Not captured (missing_due_to_gap)");
    expect(field?.source).toBe("step.domAfter.reason");
  });

  it("does not read the clock", () => {
    const step = makeSealedUserActionStep(record, stepId(5), 5);
    const rendered = renderFactSummary(buildFactSummary({ step }));
    // Every number in the output traces to the fixture clock, not `Date.now()`.
    expect(rendered).toContain(String(step.endedAt - T0));
    expect(rendered).not.toContain(String(Date.now()));
  });

  it("localizes labels and DOM copy per explicit locale (crawler-12)", () => {
    const step = makeSealedUserActionStep(record, stepId(6), 6);

    const zhSummary = buildFactSummary({ step, locale: "zh" });
    const enSummary = buildFactSummary({ step, locale: "en" });

    const zhLabels = new Map(zhSummary.fields.map((field) => [field.label, field.value]));
    const enLabels = new Map(enSummary.fields.map((field) => [field.label, field.value]));

    expect(zhLabels.has("操作类型")).toBe(true);
    expect(enLabels.has("Action type")).toBe(true);
    expect(enLabels.has("操作类型")).toBe(false);

    // Localized DOM copy keeps data values intact.
    expect(zhLabels.get("DOM 变化")).toContain("新增");
    expect(enLabels.get("DOM changes")).toContain("added");

    // Same step + same locale is still byte-identical.
    expect(renderFactSummary(zhSummary)).toBe(renderFactSummary(buildFactSummary({ step, locale: "zh" })));
  });
});
