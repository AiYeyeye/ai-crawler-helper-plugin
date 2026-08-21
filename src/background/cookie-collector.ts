import type { CookieRecord, StorageSnapshotContent } from "../schemas/storage";
import { originMatchPattern } from "../core/target-eligibility";

/**
 * Cookie collection over `chrome.cookies` within granted origins (design 10/11).
 *
 * The chrome APIs are injected as narrow structural interfaces rather than
 * imported from `@types/chrome`, so the collector is unit-testable against
 * deterministic fixtures and does not break when Chrome adds fields.
 */

/** Subset of `chrome.cookies.Cookie` this collector reads. */
export interface ChromeCookieLike {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly session?: boolean | undefined;
  /** Seconds since the UNIX epoch, absent for session cookies. */
  readonly expirationDate?: number | undefined;
  readonly sameSite?: string | undefined;
  /** Present only for partitioned (CHIPS) cookies. */
  readonly partitionKey?: unknown;
}

export interface CookiesApi {
  getAll(details: { readonly url: string }): Promise<readonly ChromeCookieLike[]>;
}

export interface PermissionsApi {
  contains(descriptor: { readonly origins: readonly string[] }): Promise<boolean>;
}

/** `not_collected` arm shared by every storage domain. */
export type NotCollected = Extract<
  StorageSnapshotContent["cookies"],
  { status: "not_collected" }
>;

const SAME_SITE_VALUES = ["no_restriction", "lax", "strict", "unspecified"] as const;
type SameSite = (typeof SAME_SITE_VALUES)[number];

/**
 * Map Chrome's `sameSite` to the schema enum. An unknown/absent value becomes
 * `unspecified` — which is exactly what Chrome means by it — rather than a
 * guess at the browser's default.
 */
export const normalizeSameSite = (value: string | undefined): SameSite => {
  const found = SAME_SITE_VALUES.find((candidate) => candidate === value);
  return found ?? "unspecified";
};

/** Chrome reports expiry in seconds; the schema stores epoch milliseconds. */
export const toExpiresAtMs = (expirationDate: number | undefined): number | undefined =>
  expirationDate === undefined ? undefined : Math.round(expirationDate * 1000);

export const toCookieRecord = (cookie: ChromeCookieLike): CookieRecord => {
  const expiresAt = toExpiresAtMs(cookie.expirationDate);
  return {
    name: cookie.name,
    // Raw value, never masked (PRD 4.9) — the recording is the artifact.
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: normalizeSameSite(cookie.sameSite),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(cookie.partitionKey === undefined || cookie.partitionKey === null
      ? {}
      : { partitioned: true }),
  };
};

/** Origin pattern accepted by `chrome.permissions.contains`. */
export { originMatchPattern };

export interface CookieCollectionOptions {
  readonly cookies: CookiesApi;
  readonly permissions: PermissionsApi;
  /** Extra user-configured origins beyond the recorded one. */
  readonly additionalOrigins?: readonly string[];
}

export type CookieCollectionResult = StorageSnapshotContent["cookies"];

/**
 * Read cookies for an origin, but only when the host permission is actually
 * granted. An unauthorized origin yields `not_applicable` — never an empty
 * cookie list, which would be indistinguishable from "this site has no
 * cookies" (PRD acceptance: unauthorized origins must be explicit).
 */
export const collectCookiesForOrigin = async (
  origin: string,
  options: CookieCollectionOptions,
): Promise<CookieCollectionResult> => {
  let granted: boolean;
  try {
    granted = await options.permissions.contains({ origins: [originMatchPattern(origin)] });
  } catch {
    return { status: "not_collected", reason: "permission_missing" };
  }
  if (!granted) {
    return { status: "not_collected", reason: "not_applicable" };
  }

  const origins = [origin, ...(options.additionalOrigins ?? [])];
  const collected: CookieRecord[] = [];
  const seen = new Set<string>();
  for (const target of origins) {
    let batch: readonly ChromeCookieLike[];
    try {
      batch = await options.cookies.getAll({ url: target });
    } catch {
      // A single origin failing must not silently shrink the result set.
      return { status: "not_collected", reason: "missing_due_to_gap" };
    }
    for (const cookie of batch) {
      const record = toCookieRecord(cookie);
      const identity = JSON.stringify([record.domain, record.path, record.name]);
      if (seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      collected.push(record);
    }
  }
  return { status: "collected", value: collected };
};
