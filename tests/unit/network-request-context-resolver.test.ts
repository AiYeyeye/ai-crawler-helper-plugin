import { describe, expect, it } from "vitest";
import { NetworkRequestContextResolver } from "../../src/background/network-request-context-resolver";
import type { DebuggerCaptureContext } from "../../src/background/network-capture-controller";
import { SCHEMA_VERSION } from "../../src/schemas/common";
import type { DocumentContextRecord } from "../../src/schemas/navigation";
import type { IdentifierMappingRecord } from "../../src/schemas/network";
import {
  attachEpochSchema,
  captureEpochIdSchema,
  cdpFrameIdSchema,
  cdpLoaderIdSchema,
  cdpSessionIdSchema,
  extDocumentIdSchema,
  extFrameIdSchema,
  extTabIdSchema,
  sessionIdSchema,
} from "../../src/shared/ids";
import { makeControlRecord, makeSessionRecord } from "../helpers/fixtures";

const context: DebuggerCaptureContext = {
  sessionId: sessionIdSchema.parse("ses-resolver"),
  tabId: extTabIdSchema.parse(5),
  attachEpoch: attachEpochSchema.parse(2),
};

const currentControl = makeControlRecord(
  makeSessionRecord({ sessionId: context.sessionId, rootTabId: context.tabId }),
);

const sessions = {
  getControl: () => Promise.resolve(currentControl),
};

const document = (frameId: number, documentId: string, url: string): DocumentContextRecord => ({
  schemaVersion: SCHEMA_VERSION,
  documentKey: `doc-key-${String(frameId)}`,
  sessionId: context.sessionId,
  captureEpochId: captureEpochIdSchema.parse("cep-resolver"),
  tabId: context.tabId,
  frameId: extFrameIdSchema.parse(frameId),
  documentId: extDocumentIdSchema.parse(documentId),
  url,
  committedAt: 1_700_000_000_000,
});

describe("NetworkRequestContextResolver", () => {
  it("keeps a worker child with an empty loaderId ambiguous despite an identical URL", async () => {
    const root = document(0, "doc-root", "https://example.com/same");
    const resolver = new NetworkRequestContextResolver({
      sessions,
      networkState: { getIdentifierMapping: () => Promise.resolve(null) },
      navigationContexts: {
        getCurrentDocument: (_sessionId, _tabId, frameId) =>
          Promise.resolve(frameId === root.frameId ? root : null),
      },
    });

    const workerContext = {
      ...context,
      childSessionId: cdpSessionIdSchema.parse("child-worker-empty-loader"),
    };
    const result = await resolver.resolve(workerContext, {
      url: root.url,
      frameId: "CDP-FRAME-SAME-URL",
      loaderId: "",
    });

    expect(result).toMatchObject({
      stepContext: { scope: { documentId: "doc-root", frameId: 0 } },
      identifierMapping: {
        state: "ambiguous",
        cdp: {
          sessionId: "child-worker-empty-loader",
          frameId: "CDP-FRAME-SAME-URL",
          loaderId: "",
        },
      },
    });
  });

  it("uses a confirmed mapping only while its extension document is still current", async () => {
    const iframe = document(7, "doc-oopif", "https://example.com/frame");
    const mapping: IdentifierMappingRecord = {
      schemaVersion: SCHEMA_VERSION,
      mappingKey: "mapping-key",
      sessionId: context.sessionId,
      captureEpochId: iframe.captureEpochId,
      tabId: context.tabId,
      attachEpoch: context.attachEpoch,
      frameId: cdpFrameIdSchema.parse("CDP-FRAME-7"),
      loaderId: cdpLoaderIdSchema.parse("LOADER-7"),
      mapping: {
        state: "confirmed",
        ext: { tabId: context.tabId, frameId: iframe.frameId, documentId: iframe.documentId },
        cdp: { frameId: cdpFrameIdSchema.parse("CDP-FRAME-7") },
        evidence: "browser_verified_mapping:nav-7",
      },
      recordedAt: iframe.committedAt,
    };
    const resolver = new NetworkRequestContextResolver({
      sessions,
      networkState: { getIdentifierMapping: () => Promise.resolve(mapping) },
      navigationContexts: { getCurrentDocument: () => Promise.resolve(iframe) },
    });

    await expect(
      resolver.resolve(context, {
        url: "https://different.example/does-not-matter",
        frameId: "CDP-FRAME-7",
        loaderId: "LOADER-7",
      }),
    ).resolves.toMatchObject({
      stepContext: { scope: { documentId: "doc-oopif", frameId: 7 } },
      identifierMapping: {
        state: "confirmed",
        evidence: "browser_verified_mapping:nav-7",
      },
    });
  });

  it("returns unresolved when no durable extension document scope exists", async () => {
    const resolver = new NetworkRequestContextResolver({
      sessions,
      networkState: { getIdentifierMapping: () => Promise.resolve(null) },
      navigationContexts: { getCurrentDocument: () => Promise.resolve(null) },
    });

    await expect(resolver.resolve(context, { url: "https://example.com/early" })).resolves.toBeNull();
  });

  it("does not reuse a confirmed mapping after a cross-process loader change", async () => {
    const current = document(0, "doc-after-process-swap", "https://example.com/same");
    const oldMapping: IdentifierMappingRecord = {
      schemaVersion: SCHEMA_VERSION,
      mappingKey: "old-process-mapping",
      sessionId: context.sessionId,
      captureEpochId: current.captureEpochId,
      tabId: context.tabId,
      attachEpoch: context.attachEpoch,
      frameId: cdpFrameIdSchema.parse("CDP-FRAME-ROOT"),
      loaderId: cdpLoaderIdSchema.parse("LOADER-BEFORE-SWAP"),
      mapping: {
        state: "confirmed",
        ext: {
          tabId: context.tabId,
          frameId: current.frameId,
          documentId: extDocumentIdSchema.parse("doc-before-process-swap"),
        },
        cdp: {
          frameId: cdpFrameIdSchema.parse("CDP-FRAME-ROOT"),
          loaderId: cdpLoaderIdSchema.parse("LOADER-BEFORE-SWAP"),
        },
        evidence: "navigation_commit_before_process_swap",
      },
      recordedAt: current.committedAt - 1,
    };
    const resolver = new NetworkRequestContextResolver({
      sessions,
      networkState: {
        getIdentifierMapping: (key) =>
          Promise.resolve(key.loaderId === oldMapping.loaderId ? oldMapping : null),
      },
      navigationContexts: { getCurrentDocument: () => Promise.resolve(current) },
    });

    await expect(
      resolver.resolve(context, {
        url: current.url,
        frameId: "CDP-FRAME-ROOT",
        loaderId: "LOADER-AFTER-SWAP",
      }),
    ).resolves.toMatchObject({
      stepContext: { scope: { documentId: "doc-after-process-swap" } },
      identifierMapping: {
        state: "ambiguous",
        cdp: { frameId: "CDP-FRAME-ROOT", loaderId: "LOADER-AFTER-SWAP" },
      },
    });
  });

  it("uses the current session-control epoch after explicit resume", async () => {
    const root = document(0, "doc-before-resume", "https://example.com/resumed");
    const resumedEpoch = captureEpochIdSchema.parse("cep-resumed");
    const resolver = new NetworkRequestContextResolver({
      sessions: {
        getControl: () =>
          Promise.resolve({ ...currentControl, captureEpochId: resumedEpoch }),
      },
      networkState: { getIdentifierMapping: () => Promise.resolve(null) },
      navigationContexts: { getCurrentDocument: () => Promise.resolve(root) },
    });

    await expect(resolver.resolve(context, { url: root.url })).resolves.toMatchObject({
      stepContext: { captureEpochId: resumedEpoch },
    });
  });
});
