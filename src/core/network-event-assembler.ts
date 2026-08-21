import { z } from "zod";
import { SCHEMA_VERSION } from "../schemas/common";
import {
  buildRequestKey,
  requestRecordSchema,
  type HttpHeaders,
  type IdentifierMapping,
  type RequestRecord,
} from "../schemas/network";
import type { StepScope } from "../schemas/step";
import type {
  AttachEpoch,
  CaptureEpochId,
  CdpFrameId,
  CdpLoaderId,
  CdpRequestId,
  CdpSessionId,
  SessionId,
  StepId,
} from "../shared/ids";
import { utf8ByteLength } from "../shared/json-bytes";

type HeaderMap = Readonly<Record<string, string | number>>;

export interface NetworkRequestStartContext {
  sessionId: SessionId;
  captureEpochId: CaptureEpochId;
  scope: StepScope;
  startedInStepId: StepId;
  attachEpoch: AttachEpoch;
  childSessionId?: CdpSessionId;
  identifierMapping: IdentifierMapping;
  cdpClockOffsetMs?: number;
}

export interface RequestWillBeSentInput {
  context: NetworkRequestStartContext;
  requestId: CdpRequestId;
  timestampMs: number;
  request: {
    url: string;
    method: string;
    headers: HeaderMap;
    postData?: string;
  };
  resourceType?: string;
  cdpFrameId?: CdpFrameId;
  loaderId?: CdpLoaderId;
  initiator?: {
    type: string;
    requestId?: CdpRequestId;
  };
}

export interface RedirectResponseInput {
  statusCode: number;
  headers: HeaderMap;
  mimeType?: string;
}

export interface RedirectRequestWillBeSentInput extends RequestWillBeSentInput {
  redirectResponse: RedirectResponseInput;
}

export interface RequestExtraInfoInput {
  requestId: CdpRequestId;
  headers: HeaderMap;
}

export interface ResponseExtraInfoInput {
  requestId: CdpRequestId;
  statusCode: number;
  headers: HeaderMap;
}

export interface ResponseReceivedInput {
  requestId: CdpRequestId;
  timestampMs: number;
  response: {
    statusCode: number;
    headers: HeaderMap;
    mimeType?: string;
  };
  hasExtraInfo?: boolean;
}

export interface LoadingFinishedInput {
  requestId: CdpRequestId;
  timestampMs: number;
}

export interface LoadingFailedInput extends LoadingFinishedInput {
  errorText: string;
  canceled: boolean;
}

export interface RedirectTransition {
  completedRedirect: RequestRecord;
  started: RequestRecord;
}

interface RequestExtraInfo {
  headers: HttpHeaders;
}

interface ResponseExtraInfo {
  statusCode: number;
  headers: HttpHeaders;
}

interface RequestHop {
  record: RequestRecord;
  requestExtra?: RequestExtraInfo;
  responseExtra?: ResponseExtraInfo;
}

interface RequestChain {
  hops: RequestHop[];
  pendingRequestExtra: RequestExtraInfo[];
  pendingResponseExtra: ResponseExtraInfo[];
}

const graphqlBodySchema = z
  .object({
    operationName: z.string().optional(),
    query: z.string().optional(),
  })
  .passthrough();

const toHeaders = (headers: HeaderMap): HttpHeaders =>
  Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));

const parseQueryParams = (url: string): RequestRecord["queryParams"] => {
  try {
    return [...new URL(url).searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
};

const classifyGraphql = (
  url: string,
  postData: string | undefined,
): RequestRecord["graphql"] => {
  const likelyEndpoint = /(?:^|\/)graphql(?:\/|$|\?)/iu.test(url);
  if (postData === undefined) {
    return likelyEndpoint ? {} : undefined;
  }
  try {
    const parsed = graphqlBodySchema.safeParse(JSON.parse(postData));
    if (!parsed.success || (!likelyEndpoint && parsed.data.query === undefined)) {
      return undefined;
    }
    const operationType = parsed.data.query?.match(/^\s*(query|mutation|subscription)\b/iu)?.[1];
    return {
      ...(parsed.data.operationName === undefined
        ? {}
        : { operationName: parsed.data.operationName }),
      ...(operationType === undefined ? {} : { operationType: operationType.toLowerCase() }),
    };
  } catch {
    return likelyEndpoint ? {} : undefined;
  }
};

const withCdpIdentifiers = (
  mapping: IdentifierMapping,
  frameId: CdpFrameId | undefined,
  loaderId: CdpLoaderId | undefined,
): IdentifierMapping => ({
  ...mapping,
  cdp: {
    ...mapping.cdp,
    ...(frameId === undefined ? {} : { frameId }),
    ...(loaderId === undefined ? {} : { loaderId }),
  },
});

const currentHop = (chain: RequestChain): RequestHop => {
  const hop = chain.hops.at(-1);
  if (hop === undefined) {
    throw new Error("network event arrived before requestWillBeSent");
  }
  return hop;
};

const classifyPreflight = (
  chains: ReadonlyMap<CdpRequestId, RequestChain>,
  initiator: RequestWillBeSentInput["initiator"],
): RequestRecord["preflight"] => {
  if (initiator?.type !== "preflight") {
    return { state: "none" };
  }
  if (initiator.requestId === undefined) {
    return { state: "ambiguous", reason: "missing_request_reference" };
  }
  const referenced = chains.get(initiator.requestId)?.hops.at(-1)?.record;
  if (referenced === undefined) {
    return {
      state: "ambiguous",
      referencedRequestId: initiator.requestId,
      reason: "referenced_request_unavailable",
    };
  }
  if (referenced.method.toUpperCase() !== "OPTIONS") {
    return {
      state: "ambiguous",
      referencedRequestId: initiator.requestId,
      reason: "referenced_request_not_options",
    };
  }
  return {
    state: "occurred",
    requestKey: referenced.requestKey,
    method: "OPTIONS",
    url: referenced.url,
    ...(referenced.statusCode === undefined ? {} : { statusCode: referenced.statusCode }),
  };
};

/**
 * Deterministic CDP request/response assembler.
 *
 * One instance is scoped to one root/child debugger session. It buffers only
 * event-order joins; every returned record is ready for durable persistence.
 */
export class NetworkEventAssembler {
  private readonly chains = new Map<CdpRequestId, RequestChain>();

  restoreRequest(rawRecord: RequestRecord): void {
    const record = requestRecordSchema.parse(rawRecord);
    const requestId = record.keyParts.requestId;
    const chain = this.chains.get(requestId) ?? {
      hops: [],
      pendingRequestExtra: [],
      pendingResponseExtra: [],
    };
    const existingIndex = chain.hops.findIndex(
      (hop) => hop.record.requestKey === record.requestKey,
    );
    if (existingIndex >= 0) {
      const existing = chain.hops[existingIndex];
      if (existing === undefined) {
        throw new Error(`restored request hop disappeared: ${record.requestKey}`);
      }
      existing.record = record;
    } else {
      chain.hops.push({ record });
      chain.hops.sort(
        (left, right) => left.record.keyParts.redirectHop - right.record.keyParts.redirectHop,
      );
    }
    this.chains.set(requestId, chain);
  }

  onRequestWillBeSent(input: RedirectRequestWillBeSentInput): RedirectTransition;
  onRequestWillBeSent(input: RequestWillBeSentInput): RequestRecord;
  onRequestWillBeSent(
    input: RequestWillBeSentInput | RedirectRequestWillBeSentInput,
  ): RequestRecord | RedirectTransition {
    const existing = this.chains.get(input.requestId);
    let completedRedirect: RequestRecord | undefined;
    const redirectUrls = existing?.hops.at(-1)?.record.redirectChainUrls ?? [];
    if ("redirectResponse" in input) {
      if (existing === undefined) {
        throw new Error("redirect response has no preceding request hop");
      }
      const previous = currentHop(existing);
      const responseExtra = previous.responseExtra ?? existing.pendingResponseExtra.shift();
      completedRedirect = requestRecordSchema.parse({
        ...previous.record,
        statusCode: responseExtra?.statusCode ?? input.redirectResponse.statusCode,
        responseHeaders: responseExtra?.headers ?? toHeaders(input.redirectResponse.headers),
        completedAt: input.timestampMs,
        durationMs: Math.max(0, input.timestampMs - previous.record.startedAt),
        redirectChainUrls: [...redirectUrls, previous.record.url, input.request.url].filter(
          (value, index, values) => index === 0 || value !== values[index - 1],
        ),
      });
      previous.record = completedRedirect;
    }

    const chain = existing ?? {
      hops: [],
      pendingRequestExtra: [],
      pendingResponseExtra: [],
    };
    const redirectHop = chain.hops.length;
    const keyParts = {
      tabId: input.context.scope.tabId,
      ...(input.context.childSessionId === undefined
        ? {}
        : { childSessionId: input.context.childSessionId }),
      attachEpoch: input.context.attachEpoch,
      requestId: input.requestId,
      redirectHop,
    };
    const requestExtra = chain.pendingRequestExtra.shift();
    const graphql = classifyGraphql(input.request.url, input.request.postData);
    const preflight = classifyPreflight(this.chains, input.initiator);
    const record = requestRecordSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      requestKey: buildRequestKey(keyParts),
      keyParts,
      sessionId: input.context.sessionId,
      captureEpochId: input.context.captureEpochId,
      scope: input.context.scope,
      startedInStepId: input.context.startedInStepId,
      blocksStep: true,
      identifierMapping: withCdpIdentifiers(
        input.context.identifierMapping,
        input.cdpFrameId,
        input.loaderId,
      ),
      method: input.request.method,
      url: input.request.url,
      queryParams: parseQueryParams(input.request.url),
      requestHeaders: requestExtra?.headers ?? toHeaders(input.request.headers),
      requestExtraInfoState: requestExtra === undefined ? "unknown" : "received",
      responseExtraInfoState: "unknown",
      ...(input.request.postData === undefined
        ? { requestBody: { kind: "none" } }
        : { requestBody: { kind: "text", text: input.request.postData } }),
      ...(input.resourceType === undefined ? {} : { resourceType: input.resourceType }),
      ...(graphql === undefined ? {} : { graphql }),
      preflight,
      ...(completedRedirect === undefined
        ? {}
        : { redirectChainUrls: completedRedirect.redirectChainUrls }),
      startedAt: input.timestampMs,
      ...(input.context.cdpClockOffsetMs === undefined
        ? {}
        : { cdpClockOffsetMs: input.context.cdpClockOffsetMs }),
    });
    chain.hops.push({ record, ...(requestExtra === undefined ? {} : { requestExtra }) });
    this.chains.set(input.requestId, chain);
    return completedRedirect === undefined
      ? record
      : { completedRedirect, started: record };
  }

  onRequestExtraInfo(input: RequestExtraInfoInput): RequestRecord | null {
    const extra: RequestExtraInfo = { headers: toHeaders(input.headers) };
    const chain = this.chains.get(input.requestId);
    if (chain === undefined) {
      this.chains.set(input.requestId, {
        hops: [],
        pendingRequestExtra: [extra],
        pendingResponseExtra: [],
      });
      return null;
    }
    const hop = chain.hops.at(-1);
    if (hop === undefined || hop.requestExtra !== undefined) {
      chain.pendingRequestExtra.push(extra);
      return null;
    }
    hop.requestExtra = extra;
    hop.record = requestRecordSchema.parse({
      ...hop.record,
      requestHeaders: extra.headers,
      requestExtraInfoState: "received",
    });
    return hop.record;
  }

  currentRecord(requestId: CdpRequestId): RequestRecord | null {
    const chain = this.chains.get(requestId);
    const hop = chain?.hops.at(-1);
    return hop?.record ?? null;
  }

  onResponseExtraInfo(input: ResponseExtraInfoInput): RequestRecord | null {
    const extra: ResponseExtraInfo = {
      statusCode: input.statusCode,
      headers: toHeaders(input.headers),
    };
    const chain = this.chains.get(input.requestId);
    const hop = chain?.hops.at(-1);
    if (chain === undefined || hop === undefined) {
      const target = chain ?? {
        hops: [],
        pendingRequestExtra: [],
        pendingResponseExtra: [],
      };
      target.pendingResponseExtra.push(extra);
      this.chains.set(input.requestId, target);
      return null;
    }
    hop.responseExtra = extra;
    hop.record = requestRecordSchema.parse({
      ...hop.record,
      statusCode: extra.statusCode,
      responseHeaders: extra.headers,
      responseExtraInfoState: "received",
    });
    return hop.record;
  }

  onResponseReceived(input: ResponseReceivedInput): RequestRecord {
    const chain = this.requireChain(input.requestId);
    const hop = currentHop(chain);
    const responseExtra = hop.responseExtra ?? chain.pendingResponseExtra.shift();
    if (responseExtra !== undefined) {
      hop.responseExtra = responseExtra;
    }
    hop.record = requestRecordSchema.parse({
      ...hop.record,
      statusCode: responseExtra?.statusCode ?? input.response.statusCode,
      responseHeaders: responseExtra?.headers ?? toHeaders(input.response.headers),
      responseExtraInfoState:
        responseExtra === undefined
          ? input.hasExtraInfo === true
            ? "expected"
            : input.hasExtraInfo === false
              ? "not_expected"
              : hop.record.responseExtraInfoState ?? "unknown"
          : "received",
      ...(input.response.mimeType === undefined
        ? {}
        : { responseMimeType: input.response.mimeType }),
    });
    return hop.record;
  }

  markStepNonBlocking(requestId: CdpRequestId): RequestRecord {
    const hop = currentHop(this.requireChain(requestId));
    hop.record = requestRecordSchema.parse({ ...hop.record, blocksStep: false });
    return hop.record;
  }

  onLoadingFinished(input: LoadingFinishedInput): RequestRecord {
    const hop = currentHop(this.requireChain(input.requestId));
    hop.record = requestRecordSchema.parse({
      ...hop.record,
      completedAt: input.timestampMs,
      durationMs: Math.max(0, input.timestampMs - hop.record.startedAt),
    });
    return hop.record;
  }

  onLoadingFailed(input: LoadingFailedInput): RequestRecord {
    const hop = currentHop(this.requireChain(input.requestId));
    hop.record = requestRecordSchema.parse({
      ...hop.record,
      completedAt: input.timestampMs,
      durationMs: Math.max(0, input.timestampMs - hop.record.startedAt),
      failure: { errorText: input.errorText, canceled: input.canceled },
    });
    return hop.record;
  }

  replaceCurrentRecord(requestId: CdpRequestId, record: RequestRecord): void {
    const hop = currentHop(this.requireChain(requestId));
    if (hop.record.requestKey !== record.requestKey) {
      throw new Error(`replacement request key does not match current hop: ${record.requestKey}`);
    }
    hop.record = requestRecordSchema.parse(record);
  }

  private requireChain(requestId: CdpRequestId): RequestChain {
    const chain = this.chains.get(requestId);
    if (chain === undefined || chain.hops.length === 0) {
      throw new Error(`network event has no request chain: ${requestId}`);
    }
    return chain;
  }
}

export type ClassifiedResponseBody =
  | {
      result: { kind: "captured"; byteLength: number; encoding: "utf8" | "base64_decoded_text" };
      text: string;
    }
  | {
      result: { kind: "binary_metadata_only"; byteLength?: number; mimeType?: string };
    }
  | {
      result: { kind: "too_large"; byteLength: number; limitBytes: number };
    };

export interface ClassifyResponseBodyInput {
  body: string;
  base64Encoded: boolean;
  mimeType?: string;
  maxBytes: number;
}

const isTextMimeType = (mimeType: string | undefined): boolean =>
  mimeType === undefined ||
  mimeType.startsWith("text/") ||
  /(?:json|javascript|xml|graphql|x-www-form-urlencoded)/iu.test(mimeType);

const decodeBase64 = (value: string): Uint8Array => {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
};

export const classifyResponseBody = (
  input: ClassifyResponseBodyInput,
): ClassifiedResponseBody => {
  if (input.base64Encoded) {
    const bytes = decodeBase64(input.body);
    if (!isTextMimeType(input.mimeType)) {
      return {
        result: {
          kind: "binary_metadata_only",
          byteLength: bytes.byteLength,
          ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
        },
      };
    }
    if (bytes.byteLength > input.maxBytes) {
      return {
        result: {
          kind: "too_large",
          byteLength: bytes.byteLength,
          limitBytes: input.maxBytes,
        },
      };
    }
    return {
      result: {
        kind: "captured",
        byteLength: bytes.byteLength,
        encoding: "base64_decoded_text",
      },
      text: new TextDecoder().decode(bytes),
    };
  }

  const byteLength = utf8ByteLength(input.body);
  if (!isTextMimeType(input.mimeType)) {
    return {
      result: {
        kind: "binary_metadata_only",
        byteLength,
        ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
      },
    };
  }
  if (byteLength > input.maxBytes) {
    return {
      result: { kind: "too_large", byteLength, limitBytes: input.maxBytes },
    };
  }
  return {
    result: { kind: "captured", byteLength, encoding: "utf8" },
    text: input.body,
  };
};
