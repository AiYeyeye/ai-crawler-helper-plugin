import { businessError, type BusinessError } from "../shared/errors";

/**
 * Recording eligibility for a tab URL (design 11 permissions, design 15
 * fallbacks). Pure so both the Popup (which owns the user gesture and asks
 * for the host grant) and the Service Worker (which verifies it) reach the
 * same verdict from the same rules.
 */

/** Schemes an extension can never attach to; surfaced as an honest refusal. */
const PROTECTED_SCHEMES: ReadonlySet<string> = new Set([
  "chrome:",
  "chrome-extension:",
  "chrome-untrusted:",
  "chrome-search:",
  "devtools:",
  "edge:",
  "extension:",
  "moz-extension:",
  "about:",
  "view-source:",
  "data:",
  "blob:",
  "javascript:",
]);

export const FILE_MATCH_PATTERN = "file:///*";

/** Origin pattern accepted by `chrome.permissions.contains/request`. */
export const originMatchPattern = (origin: string): string => `${origin.replace(/\/$/, "")}/*`;

export type TargetEligibility =
  | { readonly ok: true; readonly origin: string; readonly matchPattern: string }
  | { readonly ok: false; readonly error: BusinessError };

/**
 * `file:` is only eligible when the user has manually enabled file-URL access;
 * its origin is opaque (`null`), so the match pattern — not the origin — is
 * what the permission check must use.
 */
export const evaluateTargetEligibility = (
  rawUrl: string,
  fileSchemeAllowed: boolean,
): TargetEligibility => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      error: businessError("PROTECTED_PAGE_UNSUPPORTED", "当前标签页没有可录制的地址。", {
        url: rawUrl,
      }),
    };
  }
  if (PROTECTED_SCHEMES.has(url.protocol)) {
    return {
      ok: false,
      error: businessError(
        "PROTECTED_PAGE_UNSUPPORTED",
        "浏览器受保护页面无法录制，请切换到普通网页后重试。",
        { scheme: url.protocol },
      ),
    };
  }
  if (url.protocol === "file:") {
    return fileSchemeAllowed
      ? { ok: true, origin: url.origin, matchPattern: FILE_MATCH_PATTERN }
      : {
          ok: false,
          error: businessError(
            "PROTECTED_PAGE_UNSUPPORTED",
            "录制本地文件需要先在扩展详情页开启「允许访问文件网址」。",
            { scheme: url.protocol },
          ),
        };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      error: businessError("PROTECTED_PAGE_UNSUPPORTED", "仅支持录制 http/https 页面。", {
        scheme: url.protocol,
      }),
    };
  }
  return { ok: true, origin: url.origin, matchPattern: originMatchPattern(url.origin) };
};
