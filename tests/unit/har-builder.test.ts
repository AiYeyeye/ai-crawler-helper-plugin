import { describe, expect, it } from "vitest";
import { buildHar } from "../../src/export/har-builder";
import type { SessionExportData } from "../../src/persistence/export-readback";
import type { RequestRecord } from "../../src/schemas/network";
import {
  attachEpochSchema,
  captureEpochIdSchema,
  cdpRequestIdSchema,
  extDocumentIdSchema,
  extFrameIdSchema,
  extTabIdSchema,
  stepIdSchema,
} from "../../src/shared/ids";
import { makeControlRecord, makeSessionRecord, T0 } from "../helpers/fixtures";

const makeSampleExportData = (): SessionExportData => {
  const session = makeSessionRecord({
    lifecycle: "completed",
    originUrl: "https://example.com/login",
    startedAt: T0,
    stoppedAt: T0 + 15_000,
  });

  const request1: RequestRecord = {
    schemaVersion: 4,
    requestKey: "1|-|1|req_1|0",
    keyParts: {
      tabId: extTabIdSchema.parse(1),
      attachEpoch: attachEpochSchema.parse(1),
      requestId: cdpRequestIdSchema.parse("req_1"),
      redirectHop: 0,
    },
    sessionId: session.sessionId,
    captureEpochId: captureEpochIdSchema.parse("epoch_1"),
    scope: {
      tabId: extTabIdSchema.parse(1),
      frameId: extFrameIdSchema.parse(0),
      documentId: extDocumentIdSchema.parse("doc_1"),
    },
    startedInStepId: stepIdSchema.parse("stp_0001"),
    identifierMapping: {
      state: "confirmed",
      ext: { tabId: extTabIdSchema.parse(1) },
    },
    method: "POST",
    url: "https://example.com/api/login?ref=web",
    queryParams: [{ name: "ref", value: "web" }],
    requestHeaders: [
      { name: "Content-Type", value: "application/json" },
      { name: "Cookie", value: "session_hint=active; theme=dark" },
      { name: "User-Agent", value: "Mozilla/5.0" },
    ],
    requestBody: {
      kind: "text",
      text: JSON.stringify({ username: "alice", password: "secret" }),
    },
    statusCode: 200,
    responseHeaders: [
      { name: "Content-Type", value: "application/json" },
      {
        name: "Set-Cookie",
        value: "auth_token=jwt12345; Domain=example.com; Path=/; HttpOnly; Secure",
      },
    ],
    responseMimeType: "application/json",
    responseBody: {
      kind: "captured",
      bodyRef: "body_1",
      byteLength: 45,
      encoding: "utf8",
    },
    resourceType: "XHR",
    startedAt: T0 + 1000,
    completedAt: T0 + 1250,
    durationMs: 250,
  };

  const request2: RequestRecord = {
    schemaVersion: 4,
    requestKey: "1|-|1|req_2|0",
    keyParts: {
      tabId: extTabIdSchema.parse(1),
      attachEpoch: attachEpochSchema.parse(1),
      requestId: cdpRequestIdSchema.parse("req_2"),
      redirectHop: 0,
    },
    sessionId: session.sessionId,
    captureEpochId: captureEpochIdSchema.parse("epoch_1"),
    scope: {
      tabId: extTabIdSchema.parse(1),
      frameId: extFrameIdSchema.parse(0),
      documentId: extDocumentIdSchema.parse("doc_1"),
    },
    startedInStepId: stepIdSchema.parse("stp_0002"),
    identifierMapping: {
      state: "confirmed",
      ext: { tabId: extTabIdSchema.parse(1) },
    },
    method: "GET",
    url: "https://example.com/api/user/profile",
    queryParams: [],
    requestHeaders: [
      { name: "Authorization", value: "Bearer jwt12345" },
    ],
    statusCode: 200,
    responseHeaders: [
      { name: "Content-Type", value: "application/json" },
    ],
    responseMimeType: "application/json",
    responseBody: {
      kind: "filtered",
      ruleId: "pattern_filter",
    },
    resourceType: "Fetch",
    startedAt: T0 + 2000,
    completedAt: T0 + 2100,
    durationMs: 100,
  };

  return {
    session,
    control: makeControlRecord(session),
    steps: [],
    domRecords: [],
    navigations: [],
    requests: [request1, request2],
    responseBodies: [
      {
        schemaVersion: 4,
        bodyRef: "body_1",
        requestKey: request1.requestKey,
        sessionId: session.sessionId,
        text: JSON.stringify({ token: "jwt12345", userId: "usr_alice" }),
        byteLength: 45,
        recordedAt: T0 + 1250,
      },
    ],
    networkStreamMessages: [],
    identifierMappings: [],
    storageSnapshots: [],
    storageDiffs: [],
    captureGaps: [],
  };
};

describe("HAR 1.2 builder", () => {
  it("builds a compliant HAR 1.2 root structure", () => {
    const data = makeSampleExportData();
    const har = buildHar(data);

    expect(har.log.version).toBe("1.2");
    expect(har.log.creator.name).toBe("ai-crawler-helper-plugin");
    expect(har.log.pages).toHaveLength(1);
    expect(har.log.pages?.[0]?.title).toBe("https://example.com/login");
    expect(har.log.entries).toHaveLength(2);
  });

  it("correctly maps request details, cookies, query params and postData", () => {
    const data = makeSampleExportData();
    const har = buildHar(data);

    const entry1 = har.log.entries[0];
    expect(entry1).toBeDefined();
    if (entry1 === undefined) return;

    expect(entry1.request.method).toBe("POST");
    expect(entry1.request.url).toBe("https://example.com/api/login?ref=web");
    expect(entry1.request.queryString).toEqual([{ name: "ref", value: "web" }]);
    expect(entry1.request.cookies).toEqual([
      { name: "session_hint", value: "active" },
      { name: "theme", value: "dark" },
    ]);
    expect(entry1.request.postData?.mimeType).toBe("application/json");
    expect(entry1.request.postData?.text).toContain("alice");
    expect(entry1.request.bodySize).toBeGreaterThan(0);
    expect(entry1._stepId).toBe("stp_0001");
    expect(entry1._requestKey).toBe("1|-|1|req_1|0");
  });

  it("correctly maps response status, headers, set-cookie, and captured body", () => {
    const data = makeSampleExportData();
    const har = buildHar(data);

    const entry1 = har.log.entries[0];
    expect(entry1).toBeDefined();
    if (entry1 === undefined) return;

    expect(entry1.response.status).toBe(200);
    expect(entry1.response.cookies).toEqual([
      {
        name: "auth_token",
        value: "jwt12345",
        domain: "example.com",
        path: "/",
        httpOnly: true,
        secure: true,
      },
    ]);
    expect(entry1.response.content.mimeType).toBe("application/json");
    expect(entry1.response.content.text).toContain("jwt12345");
    expect(entry1.response.content.size).toBe(45);
    expect(entry1.time).toBe(250);
  });

  it("handles excluded, unavailable, or non-captured bodies gracefully", () => {
    const data = makeSampleExportData();
    const har = buildHar(data);

    const entry2 = har.log.entries[1];
    expect(entry2).toBeDefined();
    if (entry2 === undefined) return;

    expect(entry2.request.method).toBe("GET");
    expect(entry2.response.content.text).toBeUndefined();
    expect(entry2.response.content.comment).toContain("filtered by rule: pattern_filter");
    expect(entry2._stepId).toBe("stp_0002");
  });
});
