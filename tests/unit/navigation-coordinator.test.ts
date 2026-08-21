import { describe, expect, it } from "vitest";
import { NavigationCoordinator } from "../../src/core/navigation-coordinator";
import { SCHEMA_VERSION } from "../../src/schemas/common";
import {
  captureEpochIdSchema,
  extDocumentIdSchema,
  extFrameIdSchema,
  extTabIdSchema,
  navigationRecordIdSchema,
  sessionIdSchema,
  stepIdSchema,
} from "../../src/shared/ids";
import { T0 } from "../helpers/fixtures";

const sessionId = sessionIdSchema.parse("ses_navigation");
const captureEpochId = captureEpochIdSchema.parse("cep_navigation");
const scope = {
  tabId: extTabIdSchema.parse(7),
  documentId: extDocumentIdSchema.parse("doc-before"),
  frameId: extFrameIdSchema.parse(0),
};
const activeStepId = stepIdSchema.parse("stp_active");

const makeCoordinator = (): NavigationCoordinator => {
  let recordNo = 0;
  let stepNo = 0;
  return new NavigationCoordinator({
    newNavigationRecordId: () =>
      navigationRecordIdSchema.parse(`nav_test_${String(recordNo++)}`),
    newSystemStepId: () => stepIdSchema.parse(`stp_system_${String(stepNo++)}`),
  });
};

describe("NavigationCoordinator", () => {
  it("keeps a user-triggered history navigation in the active user step", () => {
    const result = makeCoordinator().record({
      sessionId,
      scope,
      beforeUrl: "https://example.com/list",
      afterUrl: "https://example.com/detail/1",
      afterDocumentId: scope.documentId,
      signal: { kind: "history", action: "push" },
      committedAt: T0,
      activeUserStepId: activeStepId,
    });

    expect(result.attribution).toEqual({ kind: "existing_user_step", stepId: activeStepId });
    expect(result.navigation).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
      stepId: activeStepId,
      navigationType: "history_push",
      beforeUrl: "https://example.com/list",
      afterUrl: "https://example.com/detail/1",
      redirectChain: [],
    });
    expect(result.documentTransition).toEqual({ kind: "same_document" });
  });

  it("creates an independent system step when no active user step exists", () => {
    const result = makeCoordinator().record({
      sessionId,
      scope,
      beforeUrl: "https://example.com/a",
      afterUrl: "https://example.com/b",
      afterDocumentId: extDocumentIdSchema.parse("doc-after"),
      signal: { kind: "web_navigation", navigationType: "redirect" },
      committedAt: T0 + 10,
    });

    expect(result.attribution).toEqual({
      kind: "new_system_step",
      stepId: stepIdSchema.parse("stp_system_0"),
      trigger: "auto_redirect",
    });
    expect(result.navigation.stepId).toBe(stepIdSchema.parse("stp_system_0"));
    expect(result.navigation.navigationType).toBe("redirect");
  });

  it("distinguishes a same-URL reload by document identity without requesting a page DOM", () => {
    const result = makeCoordinator().record({
      sessionId,
      scope,
      beforeUrl: "https://example.com/form",
      afterUrl: "https://example.com/form",
      afterDocumentId: extDocumentIdSchema.parse("doc-reloaded"),
      signal: { kind: "web_navigation", navigationType: "reload" },
      committedAt: T0 + 20,
    });

    expect(result.navigation.navigationType).toBe("reload");
    expect(result.documentTransition).toEqual({
      kind: "document_replaced",
      previousDocumentId: scope.documentId,
      nextDocumentId: extDocumentIdSchema.parse("doc-reloaded"),
    });
    expect("dom" in result).toBe(false);
    expect("domAfter" in result).toBe(false);
  });

  it.each([
    ["push", "history_push"],
    ["replace", "history_replace"],
    ["hash_change", "hash_change"],
  ] as const)("maps history %s to %s", (action, expectedType) => {
    const result = makeCoordinator().record({
      sessionId,
      scope,
      beforeUrl: "https://example.com/a",
      afterUrl: "https://example.com/b#section",
      afterDocumentId: scope.documentId,
      signal: { kind: "history", action },
      committedAt: T0 + 30,
    });

    expect(result.navigation.navigationType).toBe(expectedType);
    expect(result.attribution.kind).toBe("new_system_step");
  });

  it("preserves the verified redirect chain verbatim", () => {
    const redirectChain = [
      {
        fromUrl: "https://example.com/login",
        toUrl: "https://id.example.com/auth",
        statusCode: 302,
        occurredAt: T0,
      },
      {
        fromUrl: "https://id.example.com/auth",
        toUrl: "https://example.com/home",
        statusCode: 303,
        occurredAt: T0 + 5,
      },
    ];
    const result = makeCoordinator().record({
      sessionId,
      scope,
      beforeUrl: "https://example.com/login",
      afterUrl: "https://example.com/home",
      afterDocumentId: extDocumentIdSchema.parse("doc-home"),
      signal: { kind: "web_navigation", navigationType: "redirect", redirectChain },
      committedAt: T0 + 10,
      activeUserStepId: activeStepId,
    });

    expect(result.navigation.redirectChain).toEqual(redirectChain);
  });

  it("uses the supplied capture epoch when a system step is requested", () => {
    const result = makeCoordinator().record({
      sessionId,
      captureEpochId,
      scope,
      beforeUrl: "https://example.com/a",
      afterUrl: "https://example.com/a#x",
      afterDocumentId: scope.documentId,
      signal: { kind: "history", action: "hash_change" },
      committedAt: T0,
    });

    expect(result.systemStepContext).toEqual({ sessionId, captureEpochId, scope });
  });
});
