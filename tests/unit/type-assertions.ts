/**
 * Compile-time assertions (checked by `pnpm typecheck`, no runtime behavior).
 *
 * Verifies the branded identifier spaces cannot be substituted for each
 * other — the extension vs CDP namespaces stay disjoint at the type level.
 */
import type {
  CdpFrameId,
  CdpLoaderId,
  CdpRequestId,
  ExtDocumentId,
  ExtFrameId,
  ExtTabId,
  SessionId,
  StepId,
} from "../../src/shared/ids";

declare const extDocumentId: ExtDocumentId;
declare const cdpFrameId: CdpFrameId;
declare const cdpLoaderId: CdpLoaderId;
declare const cdpRequestId: CdpRequestId;
declare const extTabId: ExtTabId;
declare const extFrameId: ExtFrameId;
declare const sessionId: SessionId;
declare const stepId: StepId;

// @ts-expect-error ext documentId is not a CDP frame id
const wrong1: CdpFrameId = extDocumentId;

// @ts-expect-error CDP frame id is not an ext documentId
const wrong2: ExtDocumentId = cdpFrameId;

// @ts-expect-error CDP loaderId is not a CDP requestId (distinct brands within CDP space too)
const wrong3: CdpRequestId = cdpLoaderId;

// @ts-expect-error ext numeric frame id is not an ext tab id
const wrong4: ExtTabId = extFrameId;

// @ts-expect-error session id is not a step id
const wrong5: StepId = sessionId;

// @ts-expect-error a bare string cannot be used where a branded id is expected
const wrong6: SessionId = "ses_raw_string";

// @ts-expect-error ext numeric tab id is not a CDP request id (cross-space and cross-primitive)
const wrong7: CdpRequestId = extTabId;

// Correct same-space assignments must continue to compile:
const right1: ExtDocumentId = extDocumentId;
const right2: CdpFrameId = cdpFrameId;
const right3: StepId = stepId;
const right4: CdpRequestId = cdpRequestId;

export const __typeAssertions = [
  wrong1,
  wrong2,
  wrong3,
  wrong4,
  wrong5,
  wrong6,
  wrong7,
  right1,
  right2,
  right3,
  right4,
];
