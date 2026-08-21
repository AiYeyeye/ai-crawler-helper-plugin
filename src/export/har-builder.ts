import type { SessionExportData } from "../persistence/export-readback";
import type { RequestRecord } from "../schemas/network";

/**
 * HTTP Archive (HAR) 1.2 Specification types.
 * @see http://www.softwareishard.com/blog/har-12-spec/
 */

export interface HarHeader {
  readonly name: string;
  readonly value: string;
  readonly comment?: string;
}

export interface HarCookie {
  readonly name: string;
  readonly value: string;
  readonly path?: string;
  readonly domain?: string;
  readonly expires?: string;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly comment?: string;
}

export interface HarQueryString {
  readonly name: string;
  readonly value: string;
  readonly comment?: string;
}

export interface HarPostData {
  readonly mimeType: string;
  readonly text?: string;
  readonly params?: readonly {
    readonly name: string;
    readonly value?: string;
    readonly fileName?: string;
    readonly contentType?: string;
  }[];
  readonly comment?: string;
}

export interface HarContent {
  readonly size: number;
  readonly compression?: number;
  readonly mimeType: string;
  readonly text?: string;
  readonly encoding?: string;
  readonly comment?: string;
}

export interface HarRequest {
  readonly method: string;
  readonly url: string;
  readonly httpVersion: string;
  readonly cookies: readonly HarCookie[];
  readonly headers: readonly HarHeader[];
  readonly queryString: readonly HarQueryString[];
  readonly postData?: HarPostData;
  readonly headersSize: number;
  readonly bodySize: number;
  readonly comment?: string;
}

export interface HarResponse {
  readonly status: number;
  readonly statusText: string;
  readonly httpVersion: string;
  readonly cookies: readonly HarCookie[];
  readonly headers: readonly HarHeader[];
  readonly content: HarContent;
  readonly redirectURL: string;
  readonly headersSize: number;
  readonly bodySize: number;
  readonly comment?: string;
}

export interface HarTimings {
  readonly blocked?: number;
  readonly dns?: number;
  readonly connect?: number;
  readonly send: number;
  readonly wait: number;
  readonly receive: number;
  readonly ssl?: number;
  readonly comment?: string;
}

export interface HarEntry {
  readonly pageref?: string;
  readonly startedDateTime: string;
  readonly time: number;
  readonly request: HarRequest;
  readonly response: HarResponse;
  readonly cache: Record<string, never>;
  readonly timings: HarTimings;
  readonly serverIPAddress?: string;
  readonly connection?: string;
  readonly comment?: string;
  readonly _stepId?: string;
  readonly _requestKey?: string;
  readonly _resourceType?: string;
}

export interface HarPage {
  readonly startedDateTime: string;
  readonly id: string;
  readonly title: string;
  readonly pageTimings: {
    readonly onContentLoad?: number;
    readonly onLoad?: number;
    readonly comment?: string;
  };
  readonly comment?: string;
}

export interface HarLog {
  readonly log: {
    readonly version: "1.2";
    readonly creator: {
      readonly name: string;
      readonly version: string;
      readonly comment?: string;
    };
    readonly browser?: {
      readonly name: string;
      readonly version: string;
    };
    readonly pages?: readonly HarPage[];
    readonly entries: readonly HarEntry[];
    readonly comment?: string;
  };
}

/**
 * Parse standard Request `Cookie` header into HAR cookies.
 * Format: "name1=value1; name2=value2"
 */
const parseRequestCookies = (cookieHeader: string | undefined): HarCookie[] => {
  if (cookieHeader === undefined || cookieHeader.trim() === "") {
    return [];
  }
  const cookies: HarCookie[] = [];
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === "") {
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) {
      cookies.push({ name: trimmed, value: "" });
    } else {
      cookies.push({
        name: trimmed.slice(0, eqIdx).trim(),
        value: trimmed.slice(eqIdx + 1).trim(),
      });
    }
  }
  return cookies;
};

/**
 * Parse standard Response `Set-Cookie` header into a HAR cookie.
 * Format: "name=value; Domain=...; Path=...; Expires=...; HttpOnly; Secure"
 */
const parseSetCookieHeader = (setCookieHeader: string): HarCookie => {
  const directives = setCookieHeader.split(";").map((s) => s.trim());
  const [first, ...rest] = directives;
  let name = "";
  let value = "";
  if (first !== undefined) {
    const eqIdx = first.indexOf("=");
    if (eqIdx === -1) {
      name = first;
    } else {
      name = first.slice(0, eqIdx).trim();
      value = first.slice(eqIdx + 1).trim();
    }
  }

  let domain: string | undefined;
  let path: string | undefined;
  let expires: string | undefined;
  let httpOnly: boolean | undefined;
  let secure: boolean | undefined;

  for (const item of rest) {
    const lower = item.toLowerCase();
    if (lower.startsWith("domain=")) {
      domain = item.slice(7).trim();
    } else if (lower.startsWith("path=")) {
      path = item.slice(5).trim();
    } else if (lower.startsWith("expires=")) {
      expires = item.slice(8).trim();
    } else if (lower === "httponly") {
      httpOnly = true;
    } else if (lower === "secure") {
      secure = true;
    }
  }

  return {
    name,
    value,
    ...(domain !== undefined ? { domain } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(expires !== undefined ? { expires } : {}),
    ...(httpOnly !== undefined ? { httpOnly } : {}),
    ...(secure !== undefined ? { secure } : {}),
  };
};

/**
 * Find all Set-Cookie headers in response headers.
 */
const parseResponseCookies = (
  headers: readonly { readonly name: string; readonly value: string }[] | undefined,
): HarCookie[] => {
  if (headers === undefined) {
    return [];
  }
  const cookies: HarCookie[] = [];
  for (const header of headers) {
    if (header.name.toLowerCase() === "set-cookie") {
      cookies.push(parseSetCookieHeader(header.value));
    }
  }
  return cookies;
};

/**
 * Build HAR PostData representation.
 */
const buildPostData = (
  requestBody: RequestRecord["requestBody"],
  headers: readonly { readonly name: string; readonly value: string }[],
): HarPostData | undefined => {
  if (requestBody === undefined || requestBody.kind === "none") {
    return undefined;
  }
  const contentType =
    headers.find((h) => h.name.toLowerCase() === "content-type")?.value ??
    "application/octet-stream";

  if (requestBody.kind === "text") {
    return {
      mimeType: contentType,
      text: requestBody.text,
    };
  }

  if (requestBody.kind === "binary_metadata_only") {
    return {
      mimeType: contentType,
      comment: `[binary metadata only: ${String(requestBody.byteLength)} bytes]`,
    };
  }

  if (requestBody.kind === "unavailable") {
    return {
      mimeType: contentType,
      comment: `[unavailable: ${requestBody.reason}]`,
    };
  }

  return undefined;
};

/**
 * Builds standard HAR 1.2 log structure from session export data.
 */
export const buildHar = (data: SessionExportData): HarLog => {
  const bodyMap = new Map(data.responseBodies.map((b) => [b.bodyRef, b]));

  // Build pages from navigations or main session
  const pages: HarPage[] = [];
  if (data.navigations.length > 0) {
    data.navigations.forEach((nav, idx) => {
      pages.push({
        id: `page_${String(idx + 1)}`,
        title: nav.afterUrl,
        startedDateTime: new Date(nav.committedAt).toISOString(),
        pageTimings: {},
      });
    });
  } else {
    pages.push({
      id: "page_1",
      title: data.session.originUrl,
      startedDateTime: new Date(data.session.startedAt).toISOString(),
      pageTimings: {},
    });
  }

  const entries: HarEntry[] = data.requests.map((req) => {
    const startedDateTime = new Date(req.startedAt).toISOString();
    const duration = req.durationMs ?? 0;

    // Headers & cookies
    const reqHeaders: HarHeader[] = req.requestHeaders.map((h) => ({
      name: h.name,
      value: h.value,
    }));
    const cookieHeader = req.requestHeaders.find(
      (h) => h.name.toLowerCase() === "cookie",
    )?.value;
    const reqCookies = parseRequestCookies(cookieHeader);

    // Query string params
    const queryParams: HarQueryString[] = req.queryParams.map((q) => ({
      name: q.name,
      value: q.value,
    }));

    // Post data & body sizes
    const postData = buildPostData(req.requestBody, req.requestHeaders);
    let reqBodySize = 0;
    if (req.requestBody?.kind === "text") {
      reqBodySize = new TextEncoder().encode(req.requestBody.text).length;
    } else if (req.requestBody?.kind === "binary_metadata_only") {
      reqBodySize = req.requestBody.byteLength;
    }

    // Response headers & cookies
    const resHeaders: HarHeader[] = (req.responseHeaders ?? []).map((h) => ({
      name: h.name,
      value: h.value,
    }));
    const resCookies = parseResponseCookies(req.responseHeaders);

    // Response redirect URL
    const redirectURL =
      req.responseHeaders?.find((h) => h.name.toLowerCase() === "location")?.value ??
      "";

    // Response content
    let contentText: string | undefined;
    let contentSize = 0;
    let contentComment: string | undefined;

    if (req.responseBody !== undefined) {
      if (req.responseBody.kind === "captured") {
        const bodyRecord = bodyMap.get(req.responseBody.bodyRef);
        if (bodyRecord !== undefined) {
          contentText = bodyRecord.text;
          contentSize = bodyRecord.byteLength;
        } else {
          contentSize = req.responseBody.byteLength;
          contentComment = "[body reference unresolvable in storage]";
        }
      } else if (req.responseBody.kind === "filtered") {
        contentComment = `[filtered by rule: ${req.responseBody.ruleId}]`;
      } else if (req.responseBody.kind === "too_large") {
        contentSize = req.responseBody.byteLength;
        contentComment = `[truncated: exceeds limit of ${String(req.responseBody.limitBytes)} bytes]`;
      } else if (req.responseBody.kind === "binary_metadata_only") {
        contentSize = req.responseBody.byteLength ?? 0;
        contentComment = `[binary body: ${String(req.responseBody.byteLength ?? 0)} bytes]`;
      } else if (req.responseBody.kind === "unavailable") {
        contentComment = `[unavailable: ${req.responseBody.reason}]`;
      } else if (req.responseBody.kind === "missing_due_to_gap") {
        contentComment = `[missing due to capture gap: ${req.responseBody.gapId}]`;
      }
    }

    const content: HarContent = {
      size: contentSize,
      mimeType: req.responseMimeType ?? "application/octet-stream",
      ...(contentText !== undefined ? { text: contentText } : {}),
      ...(contentComment !== undefined ? { comment: contentComment } : {}),
    };

    const entry: HarEntry = {
      startedDateTime,
      time: duration,
      request: {
        method: req.method,
        url: req.url,
        httpVersion: "HTTP/1.1",
        cookies: reqCookies,
        headers: reqHeaders,
        queryString: queryParams,
        ...(postData !== undefined ? { postData } : {}),
        headersSize: -1,
        bodySize: reqBodySize,
      },
      response: {
        status: req.statusCode ?? 0,
        statusText: req.statusCode !== undefined ? "OK" : "",
        httpVersion: "HTTP/1.1",
        cookies: resCookies,
        headers: resHeaders,
        content,
        redirectURL,
        headersSize: -1,
        bodySize: contentSize,
      },
      cache: {},
      timings: {
        send: 0,
        wait: duration,
        receive: 0,
      },
      _stepId: req.startedInStepId,
      _requestKey: req.requestKey,
      ...(req.resourceType !== undefined ? { _resourceType: req.resourceType } : {}),
    };

    return entry;
  });

  return {
    log: {
      version: "1.2",
      creator: {
        name: "ai-crawler-helper-plugin",
        version: "0.1.0",
      },
      pages,
      entries,
    },
  };
};
