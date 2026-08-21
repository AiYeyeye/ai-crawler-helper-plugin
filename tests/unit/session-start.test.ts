import { describe, expect, it, vi } from "vitest";
import {
  contentScriptIdFor,
  startRecordingSession,
  type StartRecordingDeps,
} from "../../src/background/session-start";
import { evaluateTargetEligibility } from "../../src/core/target-eligibility";
import type { CaptureCollector } from "../../src/core/collector-contracts";
import { businessError } from "../../src/shared/errors";
import { defaultAppSettings } from "../../src/persistence/settings-repository";
import { T0, makeSessionRecord } from "../helpers/fixtures";

/**
 * Start orchestration (design 4/11): permission, content-script registration
 * and collector attach must all succeed before a session may report
 * `recording`. Any refusal rolls the session back to `idle` with the
 * collectors disconnected — never a half-capturing session.
 */

const session = makeSessionRecord({ lifecycle: "starting" });

interface Harness {
  deps: StartRecordingDeps;
  lifecycle: string[];
  started: string[];
  disconnected: string[];
  reloaded: number[];
  registered: string[];
}

const collector = (
  name: CaptureCollector["name"],
  behaviour: "ok" | "refuse" | "throw",
  log: { started: string[]; disconnected: string[] },
): CaptureCollector => ({
  name,
  start: () => {
    if (behaviour === "throw") {
      throw new Error("attach exploded");
    }
    if (behaviour === "refuse") {
      return Promise.resolve({
        ok: false,
        error: businessError("DEBUGGER_ATTACH_FAILED", "attach refused"),
      });
    }
    log.started.push(name);
    return Promise.resolve({ ok: true });
  },
  stop: () => Promise.resolve(),
  disconnect: (sessionId) => {
    log.disconnected.push(`${name}:${sessionId}`);
    return Promise.resolve();
  },
});

const harness = (options: {
  url?: string;
  granted?: boolean;
  collectors?: CaptureCollector[];
  fileAllowed?: boolean;
  registerThrows?: boolean;
  tabMissing?: boolean;
} = {}): Harness => {
  const lifecycle: string[] = [];
  const log = { started: [] as string[], disconnected: [] as string[] };
  const reloaded: number[] = [];
  const registered: string[] = [];
  const collectors = options.collectors ?? [collector("debugger_network", "ok", log)];

  const deps: StartRecordingDeps = {
    sessions: {
      createSession: () => Promise.resolve(session),
      applyLifecycleEvent: (_sessionId, event) => {
        lifecycle.push(event);
        return Promise.resolve({ outcome: "transitioned", next: "recording" });
      },
    },
    settings: { getAppSettings: () => Promise.resolve(defaultAppSettings()) },
    pipeline: { collectors },
    tabs: {
      get: () =>
        options.tabMissing === true
          ? Promise.reject(new Error("no such tab"))
          : Promise.resolve({ url: options.url ?? "https://example.com/checkout", title: "结算" }),
      reload: (tabId) => {
        reloaded.push(tabId);
        return Promise.resolve();
      },
    },
    permissions: { contains: () => Promise.resolve(options.granted ?? true) },
    contentScripts: {
      ensureRegistered: (pattern) => {
        if (options.registerThrows === true) {
          return Promise.reject(new Error("registration failed"));
        }
        registered.push(pattern);
        return Promise.resolve();
      },
    },
    isFileSchemeAllowed: () => Promise.resolve(options.fileAllowed ?? false),
    now: () => T0,
  };

  return { deps, lifecycle, started: log.started, disconnected: log.disconnected, reloaded, registered };
};

describe("target eligibility", () => {
  it("accepts http and https origins", () => {
    expect(evaluateTargetEligibility("https://example.com/a?b=1", false)).toEqual({
      ok: true,
      origin: "https://example.com",
      matchPattern: "https://example.com/*",
    });
  });

  it.each([
    "chrome://settings",
    "chrome-extension://abc/popup.html",
    "devtools://devtools/bundled/inspector.html",
    "about:blank",
    "view-source:https://example.com",
  ])("refuses the protected page %s", (url) => {
    const result = evaluateTargetEligibility(url, true);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.code).toBe("PROTECTED_PAGE_UNSUPPORTED");
  });

  it("refuses file URLs unless file access is enabled, then uses the file pattern", () => {
    expect(evaluateTargetEligibility("file:///c:/page.html", false).ok).toBe(false);
    expect(evaluateTargetEligibility("file:///c:/page.html", true)).toEqual({
      ok: true,
      origin: "null",
      matchPattern: "file:///*",
    });
  });

  it("refuses a tab with no address", () => {
    expect(evaluateTargetEligibility("", false).ok).toBe(false);
  });
});

describe("startRecordingSession", () => {
  it("registers the content script, starts collectors and completes the start", async () => {
    const context = harness();
    const result = await startRecordingSession(context.deps, { tabId: 7, mode: "no_reload" });

    expect(result.ok).toBe(true);
    expect(context.registered).toEqual(["https://example.com/*"]);
    expect(context.started).toEqual(["debugger_network"]);
    expect(context.lifecycle).toEqual(["start_completed"]);
    expect(context.reloaded).toEqual([]);
  });

  it("reloads the tab only in reload mode, after collectors attach", async () => {
    const context = harness();
    await startRecordingSession(context.deps, { tabId: 7, mode: "reload" });

    expect(context.started).toEqual(["debugger_network"]);
    expect(context.reloaded).toEqual([7]);
  });

  it("refuses without the host grant and never creates collectors", async () => {
    const context = harness({ granted: false });
    const result = await startRecordingSession(context.deps, { tabId: 7, mode: "no_reload" });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.code).toBe("SITE_PERMISSION_REQUIRED");
    expect(context.started).toEqual([]);
    expect(context.lifecycle).toEqual([]);
  });

  it("refuses a protected page before touching the repository", async () => {
    const context = harness({ url: "chrome://settings" });
    const result = await startRecordingSession(context.deps, { tabId: 7, mode: "no_reload" });

    expect(result.ok ? "" : result.error.code).toBe("PROTECTED_PAGE_UNSUPPORTED");
    expect(context.lifecycle).toEqual([]);
  });

  it("refuses when the tab is gone", async () => {
    const context = harness({ tabMissing: true });
    const result = await startRecordingSession(context.deps, { tabId: 7, mode: "no_reload" });

    expect(result.ok ? "" : result.error.code).toBe("PROTECTED_PAGE_UNSUPPORTED");
  });

  it("rolls back every started collector when a later one refuses", async () => {
    const log = { started: [] as string[], disconnected: [] as string[] };
    const context = harness({
      collectors: [
        collector("debugger_network", "ok", log),
        collector("storage", "refuse", log),
      ],
    });
    const result = await startRecordingSession(context.deps, { tabId: 7, mode: "no_reload" });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error.code).toBe("DEBUGGER_ATTACH_FAILED");
    expect(log.disconnected).toEqual([`debugger_network:${session.sessionId}`]);
    expect(context.lifecycle).toEqual(["start_aborted"]);
  });

  it("treats a throwing collector as an attach failure, not a crash", async () => {
    const log = { started: [] as string[], disconnected: [] as string[] };
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const context = harness({ collectors: [collector("debugger_network", "throw", log)] });
    const result = await startRecordingSession(context.deps, { tabId: 7, mode: "no_reload" });

    expect(result.ok ? "" : result.error.code).toBe("DEBUGGER_ATTACH_FAILED");
    expect(context.lifecycle).toEqual(["start_aborted"]);
    spy.mockRestore();
  });

  it("aborts when the content script cannot be registered", async () => {
    const context = harness({ registerThrows: true });
    const result = await startRecordingSession(context.deps, { tabId: 7, mode: "no_reload" });

    expect(result.ok ? "" : result.error.code).toBe("SITE_PERMISSION_REQUIRED");
    expect(context.started).toEqual([]);
    expect(context.lifecycle).toEqual(["start_aborted"]);
  });

  it("refuses when no collector pipeline is registered", async () => {
    const context = harness();
    const result = await startRecordingSession(
      { ...context.deps, pipeline: null },
      { tabId: 7, mode: "no_reload" },
    );

    expect(result.ok ? "" : result.error.code).toBe("CAPTURE_PIPELINE_UNAVAILABLE");
  });

  it("derives a stable, idempotent content-script id per match pattern", () => {
    expect(contentScriptIdFor("https://example.com/*")).toBe(
      contentScriptIdFor("https://example.com/*"),
    );
    expect(contentScriptIdFor("https://example.com/*")).not.toBe(
      contentScriptIdFor("https://other.com/*"),
    );
    expect(contentScriptIdFor("https://example.com/*")).toMatch(/^[a-zA-Z0-9-]+$/u);
  });
});
