import type { CollectorPipeline, CaptureCollector } from "../core/collector-contracts";
import { evaluateTargetEligibility } from "../core/target-eligibility";
import type { SessionRepository } from "../persistence/session-repository";
import type { SettingsRepository } from "../persistence/settings-repository";
import type { SessionRecord } from "../schemas/session";
import { businessError, type BusinessError, type Result } from "../shared/errors";
import { extTabIdSchema, type SessionId } from "../shared/ids";

/**
 * Start orchestration (design 4: `starting` completes permission, debugger
 * attach and the initial snapshot BEFORE the session may enter `recording`).
 *
 * Ordering is load-bearing:
 *   preflight -> create (starting) -> register content script -> collectors
 *   -> optional reload -> start_completed (recording)
 *
 * A session is never left half-capturing: if any collector refuses to start,
 * every already-started collector is disconnected and the session is aborted
 * back to `idle` (design 11: initial permission denial returns to `idle`).
 *
 * The host permission itself is requested by the Popup, which owns the user
 * gesture — `chrome.permissions.request` throws when called from a worker
 * message handler. The worker only *verifies* the grant here.
 */

export interface StartTargetTab {
  readonly url?: string | undefined;
  readonly title?: string | undefined;
}

export interface StartTabsApi {
  get(tabId: number): Promise<StartTargetTab>;
  reload(tabId: number): Promise<void>;
}

export interface StartPermissionsApi {
  contains(descriptor: { readonly origins: readonly string[] }): Promise<boolean>;
}

/** Idempotent dynamic content-script registration for a granted match pattern. */
export interface ContentScriptRegistrar {
  ensureRegistered(matchPattern: string): Promise<void>;
}

export interface StartRecordingDeps {
  readonly sessions: Pick<SessionRepository, "createSession" | "applyLifecycleEvent">;
  readonly settings: Pick<SettingsRepository, "getAppSettings">;
  readonly pipeline: CollectorPipeline | null;
  readonly tabs: StartTabsApi;
  readonly permissions: StartPermissionsApi;
  readonly contentScripts: ContentScriptRegistrar;
  readonly isFileSchemeAllowed: () => Promise<boolean>;
  readonly now: () => number;
}

export interface StartRecordingInput {
  readonly tabId: number;
  readonly mode: "no_reload" | "reload";
}

export interface StartRecordingSuccess {
  readonly sessionId: SessionId;
  readonly session: SessionRecord;
}

/** Best-effort teardown of collectors that already started, newest first. */
const disconnectAll = async (
  started: readonly CaptureCollector[],
  sessionId: SessionId,
): Promise<void> => {
  for (const collector of [...started].reverse()) {
    try {
      await collector.disconnect(sessionId);
    } catch (cause: unknown) {
      // Rollback must never mask the original failure.
      console.error("[ai-crawler-helper] collector rollback failed", collector.name, cause);
    }
  }
};

export const startRecordingSession = async (
  deps: StartRecordingDeps,
  input: StartRecordingInput,
): Promise<Result<StartRecordingSuccess>> => {
  const pipeline = deps.pipeline;
  if (pipeline === null) {
    return {
      ok: false,
      error: businessError(
        "CAPTURE_PIPELINE_UNAVAILABLE",
        "此构建未注册任何采集器，无法开始录制。",
      ),
    };
  }

  let tab: StartTargetTab;
  try {
    tab = await deps.tabs.get(input.tabId);
  } catch {
    return {
      ok: false,
      error: businessError("PROTECTED_PAGE_UNSUPPORTED", "目标标签页已不存在。", {
        tabId: input.tabId,
      }),
    };
  }

  const rawUrl = tab.url ?? "";
  const eligibility = evaluateTargetEligibility(rawUrl, await deps.isFileSchemeAllowed());
  if (!eligibility.ok) {
    return { ok: false, error: eligibility.error };
  }

  let granted: boolean;
  try {
    granted = await deps.permissions.contains({ origins: [eligibility.matchPattern] });
  } catch {
    granted = false;
  }
  if (!granted) {
    return {
      ok: false,
      error: businessError(
        "SITE_PERMISSION_REQUIRED",
        "需要先授权本站点，才能采集 DOM、Cookie 与页面存储。",
        { origin: eligibility.origin },
      ),
    };
  }

  const settings = await deps.settings.getAppSettings();
  const now = deps.now();
  const session = await deps.sessions.createSession({
    originUrl: rawUrl,
    ...(tab.title === undefined ? {} : { originTitle: tab.title }),
    rootTabId: extTabIdSchema.parse(input.tabId),
    startMode: input.mode,
    config: settings.defaultSessionConfig,
    now,
  });

  const started: CaptureCollector[] = [];
  const abort = async (error: BusinessError): Promise<Result<StartRecordingSuccess>> => {
    await disconnectAll(started, session.sessionId);
    await deps.sessions.applyLifecycleEvent(session.sessionId, "start_aborted", {
      now: deps.now(),
    });
    return { ok: false, error };
  };

  try {
    await deps.contentScripts.ensureRegistered(eligibility.matchPattern);
  } catch {
    return abort(
      businessError(
        "SITE_PERMISSION_REQUIRED",
        "无法向该站点注入内容脚本，请确认站点授权后重试。",
        { origin: eligibility.origin },
      ),
    );
  }

  for (const collector of pipeline.collectors) {
    let result;
    try {
      result = await collector.start({ session });
    } catch (cause: unknown) {
      console.error("[ai-crawler-helper] collector start threw", collector.name, cause);
      result = {
        ok: false as const,
        error: businessError(
          "DEBUGGER_ATTACH_FAILED",
          `采集器 ${collector.name} 启动失败。`,
          { collector: collector.name },
        ),
      };
    }
    if (!result.ok) {
      return abort(result.error);
    }
    started.push(collector);
  }

  if (input.mode === "reload") {
    try {
      await deps.tabs.reload(input.tabId);
    } catch (cause: unknown) {
      // The page state is already captured and collectors are attached; a
      // failed reload degrades the start mode, it does not invalidate capture.
      console.warn("[ai-crawler-helper] start-and-reload could not reload the tab", cause);
    }
  }

  await deps.sessions.applyLifecycleEvent(session.sessionId, "start_completed", {
    now: deps.now(),
  });
  return { ok: true, value: { sessionId: session.sessionId, session } };
};

/** Narrow view of `chrome.scripting` used for dynamic registration. */
export interface RegisteredContentScriptSpec {
  readonly id: string;
  readonly matches: readonly string[];
  readonly js: readonly string[];
  readonly runAt: "document_start";
  readonly allFrames: boolean;
}

export interface ContentScriptRegistrarApi {
  getRegisteredContentScripts(): Promise<readonly { readonly id: string }[]>;
  registerContentScripts(scripts: readonly RegisteredContentScriptSpec[]): Promise<void>;
}

/** Binds dynamic registration to `chrome.scripting`, keyed by match pattern. */
export const chromeContentScriptRegistrar = (
  scripting: ContentScriptRegistrarApi,
): ContentScriptRegistrar => ({
  ensureRegistered: async (matchPattern: string): Promise<void> => {
    const id = contentScriptIdFor(matchPattern);
    const registered = await scripting.getRegisteredContentScripts();
    if (registered.some((script) => script.id === id)) {
      return;
    }
    await scripting.registerContentScripts([
      {
        id,
        matches: [matchPattern],
        js: ["content-script.js"],
        runAt: "document_start",
        allFrames: true,
      },
    ]);
  },
});

/** Deterministic, filesystem-safe id so re-registration is idempotent. */
export const contentScriptIdFor = (matchPattern: string): string =>
  `ai-crawler-${matchPattern.replace(/[^a-zA-Z0-9]/gu, "-")}`;
