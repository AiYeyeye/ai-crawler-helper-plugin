import { describe, expect, it } from "vitest";
import { buildWorkflowPrompt } from "../../src/export/workflow-prompt-builder";
import type { SessionExportData } from "../../src/persistence/export-readback";
import {
  extDocumentIdSchema,
  extFrameIdSchema,
  extTabIdSchema,
  gapIdSchema,
  navigationRecordIdSchema,
  stepIdSchema,
} from "../../src/shared/ids";
import { makeControlRecord, makeSessionRecord, T0 } from "../helpers/fixtures";

const makeData = (): SessionExportData => {
  const session = makeSessionRecord({
    lifecycle: "completed",
    stoppedAt: T0 + 60_000,
    captureQuality: "degraded",
  });
  return {
    session,
    control: makeControlRecord(session),
    steps: [],
    domRecords: [],
    navigations: [
      {
        schemaVersion: 4,
        navigationRecordId: navigationRecordIdSchema.parse("nav_1"),
        sessionId: session.sessionId,
        stepId: stepIdSchema.parse("stp_1"),
        tabId: extTabIdSchema.parse(1),
        frameId: extFrameIdSchema.parse(0),
        beforeUrl: "https://a.example.com/",
        afterUrl: "https://login.example.com/",
        navigationType: "redirect",
        beforeDocumentId: undefined,
        afterDocumentId: extDocumentIdSchema.parse("doc_2"),
        redirectChain: [],
        committedAt: T0 + 10_000,
      },
    ],
    requests: [],
    responseBodies: [],
    networkStreamMessages: [],
    identifierMappings: [],
    storageSnapshots: [],
    storageDiffs: [],
    captureGaps: [
      {
        schemaVersion: 4,
        gapId: gapIdSchema.parse("gap_1"),
        scope: { sessionId: session.sessionId, collector: "debugger_network" },
        reason: "other_unrecoverable_window",
        observedStartedAt: T0 + 5_000,
        boundaryConfidence: "estimated",
        recoverable: false,
        affectedCapabilities: ["network_metadata", "network_bodies"],
        detail: "orphan event",
      },
    ],
  };
};

describe("workflow-prompt builder (crawler-12 v2)", () => {
  it("places Agent Instructions first and the fixed package guide second", () => {
    const prompt = buildWorkflowPrompt(makeData(), "en");
    const instructionIndex = prompt.indexOf("## 1. Agent Instructions");
    const packageIndex = prompt.indexOf("## 2. Export Package Guide");
    const overviewIndex = prompt.indexOf("## 3. Session Overview");
    expect(instructionIndex).toBeGreaterThanOrEqual(0);
    expect(instructionIndex).toBeLessThan(packageIndex);
    expect(packageIndex).toBeLessThan(overviewIndex);
  });

  it("localizes the fixed terminology (blind spot) and gap reasons", () => {
    const zh = buildWorkflowPrompt(makeData(), "zh");
    const en = buildWorkflowPrompt(makeData(), "en");

    // Terminology sections carry the localized blind-spot definition.
    expect(zh).toContain("盲区");
    expect(en).toContain("Blind Spot");

    // Gap reason is localized per locale.
    expect(zh).toContain("其他不可恢复窗口");
    expect(en).toContain("Other unrecoverable window");

    // Data contract values stay intact and equal across locales.
    expect(zh).toContain("https://login.example.com/");
    expect(en).toContain("https://login.example.com/");
  });

  it("keeps session overview and navigation flow data-identical across locales", () => {
    const zh = buildWorkflowPrompt(makeData(), "zh");
    const en = buildWorkflowPrompt(makeData(), "en");
    expect(zh).toContain("Session ID");
    expect(en).toContain("Session ID");
    expect(zh).toContain("https://a.example.com/ → https://login.example.com/");
    expect(en).toContain("https://a.example.com/ → https://login.example.com/");
  });
});
