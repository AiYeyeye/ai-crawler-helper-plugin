import { describe, expect, it } from "vitest";
import {
  collectCookiesForOrigin,
  normalizeSameSite,
  originMatchPattern,
  toCookieRecord,
  toExpiresAtMs,
  type ChromeCookieLike,
  type CookiesApi,
  type PermissionsApi,
} from "../../src/background/cookie-collector";

const chromeCookie = (overrides: Partial<ChromeCookieLike> = {}): ChromeCookieLike => ({
  name: "sid",
  value: "secret",
  domain: "example.com",
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  ...overrides,
});

const granted: PermissionsApi = { contains: () => Promise.resolve(true) };
const denied: PermissionsApi = { contains: () => Promise.resolve(false) };

const cookiesReturning = (byUrl: Record<string, readonly ChromeCookieLike[]>): CookiesApi => ({
  getAll: ({ url }) => Promise.resolve(byUrl[url] ?? []),
});

describe("chrome cookie mapping", () => {
  it("keeps HttpOnly / Secure / SameSite metadata", () => {
    const record = toCookieRecord(
      chromeCookie({ httpOnly: true, secure: true, sameSite: "strict" }),
    );
    expect(record).toMatchObject({ httpOnly: true, secure: true, sameSite: "strict" });
  });

  it("converts expirationDate from seconds to epoch milliseconds", () => {
    expect(toExpiresAtMs(1_800_000_000)).toBe(1_800_000_000_000);
    expect(toCookieRecord(chromeCookie({ expirationDate: 1_800_000_000 }))).toMatchObject({
      expiresAt: 1_800_000_000_000,
    });
  });

  it("omits expiresAt for session cookies rather than defaulting to 0", () => {
    expect(toExpiresAtMs(undefined)).toBeUndefined();
    expect(toCookieRecord(chromeCookie())).not.toHaveProperty("expiresAt");
  });

  it("marks partitioned (CHIPS) cookies when a partitionKey is present", () => {
    expect(toCookieRecord(chromeCookie({ partitionKey: { topLevelSite: "https://a.test" } })))
      .toMatchObject({ partitioned: true });
  });

  it("omits partitioned when there is no partitionKey", () => {
    expect(toCookieRecord(chromeCookie())).not.toHaveProperty("partitioned");
  });

  it("never masks the cookie value — the recording is the artifact", () => {
    expect(toCookieRecord(chromeCookie({ value: "secret" })).value).toBe("secret");
  });

  it("maps every SameSite variant Chrome reports", () => {
    expect(normalizeSameSite("no_restriction")).toBe("no_restriction");
    expect(normalizeSameSite("lax")).toBe("lax");
    expect(normalizeSameSite("strict")).toBe("strict");
    expect(normalizeSameSite("unspecified")).toBe("unspecified");
  });

  it("falls back to unspecified for an absent or unknown SameSite, not to a guessed default", () => {
    expect(normalizeSameSite(undefined)).toBe("unspecified");
    expect(normalizeSameSite("something_new")).toBe("unspecified");
  });
});

describe("origin match pattern", () => {
  it("builds a host permission pattern", () => {
    expect(originMatchPattern("https://example.com")).toBe("https://example.com/*");
  });

  it("does not double the slash when the origin already ends with one", () => {
    expect(originMatchPattern("https://example.com/")).toBe("https://example.com/*");
  });
});

describe("cookie collection is gated on an actual grant", () => {
  it("collects cookies for a granted origin", async () => {
    const result = await collectCookiesForOrigin("https://example.com", {
      cookies: cookiesReturning({ "https://example.com": [chromeCookie()] }),
      permissions: granted,
    });
    expect(result.status).toBe("collected");
    if (result.status === "collected") {
      expect(result.value).toHaveLength(1);
    }
  });

  it("an unauthorized origin yields not_applicable, never an empty cookie list", async () => {
    const result = await collectCookiesForOrigin("https://example.com", {
      cookies: cookiesReturning({ "https://example.com": [chromeCookie()] }),
      permissions: denied,
    });
    expect(result).toEqual({ status: "not_collected", reason: "not_applicable" });
  });

  it("a granted origin with genuinely no cookies is collected-and-empty, not not_collected", async () => {
    const result = await collectCookiesForOrigin("https://example.com", {
      cookies: cookiesReturning({}),
      permissions: granted,
    });
    expect(result).toEqual({ status: "collected", value: [] });
  });

  it("a failing permission probe degrades to permission_missing", async () => {
    const result = await collectCookiesForOrigin("https://example.com", {
      cookies: cookiesReturning({}),
      permissions: { contains: () => Promise.reject(new Error("boom")) },
    });
    expect(result).toEqual({ status: "not_collected", reason: "permission_missing" });
  });

  it("a failing getAll degrades to a gap instead of returning a partial set", async () => {
    const result = await collectCookiesForOrigin("https://example.com", {
      cookies: { getAll: () => Promise.reject(new Error("boom")) },
      permissions: granted,
    });
    expect(result).toEqual({ status: "not_collected", reason: "missing_due_to_gap" });
  });
});

describe("user-configured additional origins", () => {
  it("includes cookies from extra origins", async () => {
    const result = await collectCookiesForOrigin("https://example.com", {
      cookies: cookiesReturning({
        "https://example.com": [chromeCookie({ name: "primary" })],
        "https://api.example.com": [
          chromeCookie({ name: "extra", domain: "api.example.com" }),
        ],
      }),
      permissions: granted,
      additionalOrigins: ["https://api.example.com"],
    });
    expect(result.status).toBe("collected");
    if (result.status === "collected") {
      expect(result.value.map((cookie) => cookie.name).sort()).toEqual(["extra", "primary"]);
    }
  });

  it("deduplicates a cookie visible from two origins by (domain, path, name)", async () => {
    const shared = chromeCookie({ name: "sid", domain: ".example.com", path: "/" });
    const result = await collectCookiesForOrigin("https://example.com", {
      cookies: cookiesReturning({
        "https://example.com": [shared],
        "https://api.example.com": [shared],
      }),
      permissions: granted,
      additionalOrigins: ["https://api.example.com"],
    });
    if (result.status === "collected") {
      expect(result.value).toHaveLength(1);
    }
  });
});
