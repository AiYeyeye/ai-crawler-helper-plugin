import { describe, expect, it } from "vitest";
import {
  NetworkEventAssembler,
  classifyResponseBody,
  type NetworkRequestStartContext,
} from "../../src/core/network-event-assembler";
import { SCHEMA_VERSION } from "../../src/schemas/common";
import {
  attachEpochSchema,
  cdpFrameIdSchema,
  cdpLoaderIdSchema,
  cdpRequestIdSchema,
  captureEpochIdSchema,
  extDocumentIdSchema,
  extFrameIdSchema,
  extTabIdSchema,
  sessionIdSchema,
  stepIdSchema,
} from "../../src/shared/ids";

const T0 = 1_700_000_000_000;

const startContext = (): NetworkRequestStartContext => ({
  sessionId: sessionIdSchema.parse("ses-network"),
  captureEpochId: captureEpochIdSchema.parse("cep-network"),
  scope: {
    tabId: extTabIdSchema.parse(7),
    frameId: extFrameIdSchema.parse(0),
    documentId: extDocumentIdSchema.parse("doc-network"),
  },
  startedInStepId: stepIdSchema.parse("stp-network"),
  attachEpoch: attachEpochSchema.parse(3),
  identifierMapping: {
    state: "confirmed",
    ext: {
      tabId: extTabIdSchema.parse(7),
      frameId: extFrameIdSchema.parse(0),
      documentId: extDocumentIdSchema.parse("doc-network"),
    },
    cdp: {
      frameId: cdpFrameIdSchema.parse("FRAME-1"),
      loaderId: cdpLoaderIdSchema.parse("LOADER-1"),
    },
    evidence: "navigation_commit",
    mappedAt: T0,
  },
});

describe("NetworkEventAssembler", () => {
  it("merges ExtraInfo regardless of order and treats its response status as authoritative", () => {
    const assembler = new NetworkEventAssembler();
    const requestId = cdpRequestIdSchema.parse("REQ-1");

    assembler.onRequestExtraInfo({
      requestId,
      headers: { cookie: "sid=raw", "x-extra": "request" },
    });
    const started = assembler.onRequestWillBeSent({
      context: startContext(),
      requestId,
      timestampMs: T0,
      request: {
        url: "https://example.com/api?q=ship",
        method: "GET",
        headers: { accept: "application/json" },
      },
      resourceType: "Fetch",
      cdpFrameId: cdpFrameIdSchema.parse("FRAME-1"),
      loaderId: cdpLoaderIdSchema.parse("LOADER-1"),
    });
    expect(started.requestHeaders).toEqual([
      { name: "cookie", value: "sid=raw" },
      { name: "x-extra", value: "request" },
    ]);

    assembler.onResponseExtraInfo({
      requestId,
      statusCode: 403,
      headers: { "set-cookie": "blocked=1", "content-type": "application/json" },
    });
    const responded = assembler.onResponseReceived({
      requestId,
      timestampMs: T0 + 10,
      response: {
        statusCode: 0,
        headers: { "content-type": "application/json" },
        mimeType: "application/json",
      },
    });

    expect(responded).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
      statusCode: 403,
      responseHeaders: [
        { name: "set-cookie", value: "blocked=1" },
        { name: "content-type", value: "application/json" },
      ],
    });
    expect(assembler.onLoadingFinished({ requestId, timestampMs: T0 + 25 })).toMatchObject({
      completedAt: T0 + 25,
      durationMs: 25,
    });
  });

  it("persists a CORS failure status when only response ExtraInfo arrives", () => {
    const assembler = new NetworkEventAssembler();
    const requestId = cdpRequestIdSchema.parse("REQ-CORS-ONLY-EXTRA");
    assembler.onRequestWillBeSent({
      context: startContext(),
      requestId,
      timestampMs: T0,
      request: {
        url: "https://cross-origin.example/api",
        method: "GET",
        headers: { origin: "https://example.com" },
      },
      resourceType: "Fetch",
    });

    const withCorsStatus = assembler.onResponseExtraInfo({
      requestId,
      statusCode: 403,
      headers: { "content-type": "application/json" },
    });

    expect(withCorsStatus).toMatchObject({
      statusCode: 403,
      responseHeaders: [{ name: "content-type", value: "application/json" }],
      responseExtraInfoState: "received",
    });
    expect(
      assembler.onLoadingFailed({
        requestId,
        timestampMs: T0 + 10,
        errorText: "net::ERR_FAILED",
        canceled: false,
      }),
    ).toMatchObject({
      statusCode: 403,
      responseExtraInfoState: "received",
      failure: { errorText: "net::ERR_FAILED" },
    });
  });

  it("keeps response ExtraInfo expected when the advertised event is missing", () => {
    const assembler = new NetworkEventAssembler();
    const requestId = cdpRequestIdSchema.parse("REQ-EXTRA-MISSING");
    assembler.onRequestWillBeSent({
      context: startContext(),
      requestId,
      timestampMs: T0,
      request: { url: "https://example.com/missing-extra", method: "GET", headers: {} },
    });

    assembler.onResponseReceived({
      requestId,
      timestampMs: T0 + 5,
      response: { statusCode: 200, headers: {} },
      hasExtraInfo: true,
    });

    expect(assembler.onLoadingFinished({ requestId, timestampMs: T0 + 10 })).toMatchObject({
      responseExtraInfoState: "expected",
    });
  });

  it("marks response ExtraInfo as not expected when CDP says it will not arrive", () => {
    const assembler = new NetworkEventAssembler();
    const requestId = cdpRequestIdSchema.parse("REQ-NO-EXTRA");
    assembler.onRequestWillBeSent({
      context: startContext(),
      requestId,
      timestampMs: T0,
      request: { url: "https://example.com/no-extra", method: "GET", headers: {} },
    });

    expect(
      assembler.onResponseReceived({
        requestId,
        timestampMs: T0 + 5,
        response: { statusCode: 204, headers: {} },
        hasExtraInfo: false,
      }),
    ).toMatchObject({ responseExtraInfoState: "not_expected" });
  });

  it("keeps the cached 304 from ExtraInfo instead of the responseReceived 200", () => {
    const assembler = new NetworkEventAssembler();
    const requestId = cdpRequestIdSchema.parse("REQ-CACHE-304");
    assembler.onRequestWillBeSent({
      context: startContext(),
      requestId,
      timestampMs: T0,
      request: { url: "https://example.com/cached.json", method: "GET", headers: {} },
    });
    assembler.onResponseExtraInfo({
      requestId,
      statusCode: 304,
      headers: { etag: '"cached"' },
    });

    expect(
      assembler.onResponseReceived({
        requestId,
        timestampMs: T0 + 5,
        response: { statusCode: 200, headers: {}, mimeType: "application/json" },
        hasExtraInfo: true,
      }),
    ).toMatchObject({
      statusCode: 304,
      responseExtraInfoState: "received",
      responseHeaders: [{ name: "etag", value: '"cached"' }],
    });
  });

  it("summarizes an explicitly referenced OPTIONS preflight", () => {
    const assembler = new NetworkEventAssembler();
    const preflightId = cdpRequestIdSchema.parse("REQ-PREFLIGHT");
    const preflight = assembler.onRequestWillBeSent({
      context: startContext(),
      requestId: preflightId,
      timestampMs: T0,
      request: {
        url: "https://api.example.com/items",
        method: "OPTIONS",
        headers: { origin: "https://example.com" },
      },
      resourceType: "Preflight",
    });
    assembler.onResponseReceived({
      requestId: preflightId,
      timestampMs: T0 + 5,
      response: { statusCode: 204, headers: { "access-control-allow-origin": "*" } },
      hasExtraInfo: false,
    });
    assembler.onLoadingFinished({ requestId: preflightId, timestampMs: T0 + 6 });

    const actual = assembler.onRequestWillBeSent({
      context: startContext(),
      requestId: cdpRequestIdSchema.parse("REQ-ACTUAL-CORS"),
      timestampMs: T0 + 7,
      request: { url: "https://api.example.com/items", method: "POST", headers: {} },
      resourceType: "Fetch",
      initiator: { type: "preflight", requestId: preflightId },
    });

    expect(actual.preflight).toEqual({
      state: "occurred",
      requestKey: preflight.requestKey,
      method: "OPTIONS",
      url: "https://api.example.com/items",
      statusCode: 204,
    });
  });

  it("marks a missing explicit preflight reference as ambiguous", () => {
    const assembler = new NetworkEventAssembler();
    const actual = assembler.onRequestWillBeSent({
      context: startContext(),
      requestId: cdpRequestIdSchema.parse("REQ-ACTUAL-AMBIGUOUS"),
      timestampMs: T0,
      request: { url: "https://api.example.com/items", method: "POST", headers: {} },
      resourceType: "Fetch",
      initiator: {
        type: "preflight",
        requestId: cdpRequestIdSchema.parse("REQ-MISSING-PREFLIGHT"),
      },
    });

    expect(actual.preflight).toEqual({
      state: "ambiguous",
      referencedRequestId: "REQ-MISSING-PREFLIGHT",
      reason: "referenced_request_unavailable",
    });
  });

  it("seals the previous redirect hop and starts a new composite request key", () => {
    const assembler = new NetworkEventAssembler();
    const requestId = cdpRequestIdSchema.parse("REQ-REDIRECT");
    const first = assembler.onRequestWillBeSent({
      context: startContext(),
      requestId,
      timestampMs: T0,
      request: { url: "https://example.com/old", method: "GET", headers: {} },
      resourceType: "Document",
      cdpFrameId: cdpFrameIdSchema.parse("FRAME-1"),
      loaderId: cdpLoaderIdSchema.parse("LOADER-1"),
    });
    const redirected = assembler.onRequestWillBeSent({
      context: startContext(),
      requestId,
      timestampMs: T0 + 5,
      request: { url: "https://example.com/new", method: "GET", headers: {} },
      resourceType: "Document",
      cdpFrameId: cdpFrameIdSchema.parse("FRAME-1"),
      loaderId: cdpLoaderIdSchema.parse("LOADER-2"),
      redirectResponse: { statusCode: 302, headers: { location: "/new" } },
    });

    expect(redirected.completedRedirect).toMatchObject({
      requestKey: first.requestKey,
      statusCode: 302,
      completedAt: T0 + 5,
      redirectChainUrls: ["https://example.com/old", "https://example.com/new"],
    });
    expect(redirected.started.keyParts.redirectHop).toBe(1);
    expect(redirected.started.requestKey).not.toBe(first.requestKey);
    expect(redirected.started.redirectChainUrls).toEqual([
      "https://example.com/old",
      "https://example.com/new",
    ]);
  });

  it("classifies GraphQL from the request body without dropping ordinary metadata", () => {
    const assembler = new NetworkEventAssembler();
    const record = assembler.onRequestWillBeSent({
      context: startContext(),
      requestId: cdpRequestIdSchema.parse("REQ-GQL"),
      timestampMs: T0,
      request: {
        url: "https://example.com/graphql",
        method: "POST",
        headers: { "content-type": "application/json" },
        postData: JSON.stringify({
          operationName: "QuoteSearch",
          query: "query QuoteSearch { quotes { id } }",
        }),
      },
      resourceType: "Fetch",
      cdpFrameId: cdpFrameIdSchema.parse("FRAME-1"),
      loaderId: cdpLoaderIdSchema.parse("LOADER-1"),
    });

    expect(record.graphql).toEqual({
      operationName: "QuoteSearch",
      operationType: "query",
    });
    expect(record.requestBody).toMatchObject({ kind: "text" });
  });

  it("restores an in-flight request so late response facts keep their original attribution", () => {
    const beforeRestart = new NetworkEventAssembler();
    const requestId = cdpRequestIdSchema.parse("REQ-RESTARTED");
    const started = beforeRestart.onRequestWillBeSent({
      context: startContext(),
      requestId,
      timestampMs: T0,
      request: {
        url: "https://example.com/slow",
        method: "GET",
        headers: {},
      },
      resourceType: "Fetch",
    });
    const afterRestart = new NetworkEventAssembler();
    const restoreRequest = (
      afterRestart as unknown as Partial<{ restoreRequest: (record: typeof started) => void }>
    ).restoreRequest;
    expect(typeof restoreRequest).toBe("function");
    if (restoreRequest === undefined) {
      return;
    }
    restoreRequest.call(afterRestart, started);

    afterRestart.onResponseExtraInfo({
      requestId,
      statusCode: 304,
      headers: { "x-cache": "hit" },
    });
    afterRestart.onResponseReceived({
      requestId,
      timestampMs: T0 + 40,
      response: {
        statusCode: 200,
        headers: {},
        mimeType: "application/json",
      },
    });
    const completed = afterRestart.onLoadingFinished({
      requestId,
      timestampMs: T0 + 50,
    });

    expect(completed).toMatchObject({
      requestKey: started.requestKey,
      startedInStepId: "stp-network",
      statusCode: 304,
      responseHeaders: [{ name: "x-cache", value: "hit" }],
      completedAt: T0 + 50,
    });
  });
});

describe("classifyResponseBody", () => {
  it("distinguishes captured text, binary metadata, and oversized text", () => {
    expect(
      classifyResponseBody({
        body: "{\"ok\":true}",
        base64Encoded: false,
        mimeType: "application/json",
        maxBytes: 1_024,
      }),
    ).toEqual({
      result: { kind: "captured", byteLength: 11, encoding: "utf8" },
      text: "{\"ok\":true}",
    });
    expect(
      classifyResponseBody({
        body: "iVBORw0KGgo=",
        base64Encoded: true,
        mimeType: "image/png",
        maxBytes: 1_024,
      }),
    ).toEqual({
      result: { kind: "binary_metadata_only", byteLength: 8, mimeType: "image/png" },
    });
    expect(
      classifyResponseBody({
        body: "x".repeat(20),
        base64Encoded: false,
        mimeType: "text/plain",
        maxBytes: 10,
      }),
    ).toEqual({
      result: { kind: "too_large", byteLength: 20, limitBytes: 10 },
    });
  });
});
