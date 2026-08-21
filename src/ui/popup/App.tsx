import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  PanelRightOpen,
  Play,
  Radio,
  RefreshCw,
  ShieldAlert,
  Square,
  Trash2,
} from "lucide-react";
import {
  deleteSession,
  getAppSettings,
  getSessionSnapshot,
  listSessions,
  startRecording,
  stopRecording,
} from "../runtime-client";
import {
  evaluateTargetEligibility,
  type TargetEligibility,
} from "../../core/target-eligibility";
import type { SessionLifecycle, SessionRecord } from "../../schemas/session";
import type { SessionSnapshot } from "../../shared/messages";
import type { SessionId } from "../../shared/ids";
import {
  errorText,
  formatBytes,
  formatDuration,
  lifecycleLabel,
  qualityLabel,
} from "../format";
import { STOP_LATE_RESPONSE_WINDOW_MS } from "../../core/config";
import { DEFAULT_LOCALE, t, tpl, type Locale } from "../../shared/i18n";
import { ConfirmDialog } from "../ConfirmDialog";

/**
 * Popup (PRD 4.14): lightweight command entry — start / start+reload / stop /
 * status / open side panel.
 *
 * Two calls here are user-gesture bound and must therefore run as the FIRST
 * statement of their click handler, before any `await`:
 *  - `chrome.permissions.request` (host grant for the recorded origin)
 *  - `chrome.sidePanel.open`
 * The tab identity they need is resolved on mount so the handlers never have
 * to await a lookup and lose the gesture.
 */

interface ActiveTab {
  readonly id: number;
  readonly windowId: number;
  readonly url: string;
  readonly title?: string;
}

const ACTIVE_LIFECYCLES = new Set(["starting", "recording", "stopping", "interrupted"]);

/**
 * Lifecycles that may be deleted from the popup row (crawler-13). Starting,
 * recording and stopping sessions are protected.
 */
const DELETABLE_LIFECYCLES: ReadonlySet<SessionLifecycle> = new Set([
  "completed",
  "interrupted",
  "paused_storage_pressure",
]);

export const App = (): ReactElement => {
  const [tab, setTab] = useState<ActiveTab | null>(null);
  const [eligibility, setEligibility] = useState<TargetEligibility | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  const [deleteCandidate, setDeleteCandidate] = useState<SessionRecord | null>(null);
  const [startMode, setStartMode] = useState<"no_reload" | "reload">("no_reload");
  const [menuOpen, setMenuOpen] = useState(false);
  const splitBtnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const handleClickOutside = (event: MouseEvent): void => {
      if (splitBtnRef.current !== null && !splitBtnRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  const refresh = useCallback(async (): Promise<void> => {
    const result = await listSessions();
    if (!result.ok) {
      setMessage(errorText(result.error));
      return;
    }
    setSessions(result.value);
    const active = result.value.find((session) => ACTIVE_LIFECYCLES.has(session.lifecycle));
    if (active === undefined) {
      setSnapshot(null);
      return;
    }
    const detail = await getSessionSnapshot(active.sessionId);
    setSnapshot(detail.ok ? detail.value : null);
  }, []);

  useEffect(() => {
    void (async (): Promise<void> => {
      const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (current?.id === undefined) {
        setMessage(`PROTECTED_PAGE_UNSUPPORTED：${t(locale, "popup.noActiveTab")}`);
        return;
      }
      const url = current.url ?? "";
      setTab({
        id: current.id,
        windowId: current.windowId,
        url,
        ...(current.title === undefined ? {} : { title: current.title }),
      });
      let fileAllowed = false;
      try {
        fileAllowed = await chrome.extension.isAllowedFileSchemeAccess();
      } catch {
        fileAllowed = false;
      }
      setEligibility(evaluateTargetEligibility(url, fileAllowed));
    })();
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 2000);
    return () => {
      clearInterval(timer);
    };
  }, [refresh]);

  /** Countdown ticker for the stopping progress readout. */
  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 500);
    return () => {
      clearInterval(timer);
    };
  }, []);

  /** Load the UI language once; the side panel settings page owns switching. */
  useEffect(() => {
    void getAppSettings().then((result) => {
      if (result.ok) {
        setLocale(result.value.locale ?? DEFAULT_LOCALE);
      }
    });
  }, []);

  const handleStart = (mode: "no_reload" | "reload") => (): void => {
    if (tab === null || eligibility === null) {
      setMessage(`PROTECTED_PAGE_UNSUPPORTED：${t(locale, "popup.tabNotIdentified")}`);
      return;
    }
    if (!eligibility.ok) {
      setMessage(errorText(eligibility.error));
      return;
    }
    const matchPattern = eligibility.matchPattern;
    const tabId = tab.id;
    setBusy(true);
    setMessage(null);
    // Gesture-critical: no await may precede this call.
    chrome.permissions
      .request({ origins: [matchPattern] })
      .then(async (granted): Promise<void> => {
        if (!granted) {
          setMessage(`SITE_PERMISSION_REQUIRED：${t(locale, "popup.permissionRequired")}`);
          return;
        }
        const result = await startRecording(tabId, mode);
        if (!result.ok) {
          setMessage(errorText(result.error));
          return;
        }
        await refresh();
      })
      .catch(() => {
        setMessage(`SITE_PERMISSION_REQUIRED：${t(locale, "popup.permissionNeedsGesture")}`);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const handleStop = (sessionId: SessionId) => (): void => {
    setBusy(true);
    void stopRecording(sessionId)
      .then(async (result) => {
        if (!result.ok) {
          setMessage(errorText(result.error));
          return;
        }
        await refresh();
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const handleOpenSidePanel = (): void => {
    if (tab === null) {
      setMessage(t(locale, "popup.openNormalTabFirst"));
      return;
    }
    // Gesture-critical: called synchronously inside the click handler.
    void chrome.sidePanel
      .open({ windowId: tab.windowId })
      .then(() => {
        window.close();
      })
      .catch(() => {
        setMessage(t(locale, "popup.sidePanelNeedsGesture"));
      });
  };

  const active = sessions.find((session) => ACTIVE_LIFECYCLES.has(session.lifecycle));
  const stopping = active?.lifecycle === "stopping";
  const startable = eligibility !== null && eligibility.ok && active === undefined;

  return (
    <main className="ach-stage ach-shell-popup">
      <header className="ach-header-row ach-anim-in">
        <div className="ach-brand">
          <span className="ach-brand-mark" aria-hidden="true">
            <Radio size={18} strokeWidth={2.2} />
          </span>
          <div>
            <div className="ach-brand-kicker">{t(locale, "popup.missionControl")}</div>
            <h1 className="ach-brand-title">{t(locale, "popup.appTitle")}</h1>
          </div>
        </div>
        <span
          className={active === undefined ? "ach-status-chip" : "ach-status-chip ach-status-chip--live"}
        >
          <span className={active === undefined ? "ach-beacon" : "ach-beacon ach-beacon--live"} />
          {active === undefined
            ? t(locale, "popup.standby")
            : stopping
              ? t(locale, "popup.stoppingChip")
              : t(locale, "popup.rec")}
        </span>
      </header>

      {eligibility !== null && !eligibility.ok && (
        <p className="ach-banner ach-banner--warn ach-anim-in">
          <AlertTriangle size={14} />
          <span>{errorText(eligibility.error)}</span>
        </p>
      )}

      <div className="ach-btn-row ach-anim-in ach-anim-in-1">
        <div
          className={`ach-split-btn-group${busy || !startable ? " ach-split-btn-group--disabled" : ""}`}
          ref={splitBtnRef}
        >
          <button
            type="button"
            className="ach-split-btn__main"
            disabled={busy || !startable}
            onClick={handleStart(startMode)}
          >
            {startMode === "reload" ? <RefreshCw size={14} /> : <Play size={14} />}
            <span>
              {t(
                locale,
                startMode === "reload" ? "popup.startAndReload" : "popup.startRecording",
              )}
            </span>
          </button>
          <button
            type="button"
            className="ach-split-btn__trigger"
            disabled={busy || !startable}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            title={t(locale, "popup.modeSelectTooltip")}
            onClick={() => {
              setMenuOpen((prev) => !prev);
            }}
          >
            <ChevronDown
              size={14}
              style={{
                transform: menuOpen ? "rotate(180deg)" : "none",
                transition: "transform var(--ach-fast) var(--ach-ease)",
              }}
            />
          </button>

          {menuOpen && (
            <div className="ach-dropdown-menu" role="menu">
              <button
                type="button"
                className={`ach-dropdown-item${startMode === "no_reload" ? " ach-dropdown-item--active" : ""}`}
                role="menuitem"
                onClick={() => {
                  setStartMode("no_reload");
                  setMenuOpen(false);
                  handleStart("no_reload")();
                }}
              >
                <div className="ach-dropdown-item__header">
                  <Play size={13} style={{ color: "var(--ach-accent)" }} />
                  <span className="ach-dropdown-item__title">
                    {t(locale, "popup.startRecording")}
                  </span>
                  <span className="ach-dropdown-item__badge">
                    {t(locale, "popup.startRecordingBadge")}
                  </span>
                </div>
                <p className="ach-dropdown-item__desc">
                  {t(locale, "popup.startRecordingDesc")}
                </p>
              </button>

              <button
                type="button"
                className={`ach-dropdown-item${startMode === "reload" ? " ach-dropdown-item--active" : ""}`}
                role="menuitem"
                onClick={() => {
                  setStartMode("reload");
                  setMenuOpen(false);
                  handleStart("reload")();
                }}
              >
                <div className="ach-dropdown-item__header">
                  <RefreshCw size={13} style={{ color: "var(--ach-accent-2)" }} />
                  <span className="ach-dropdown-item__title">
                    {t(locale, "popup.startAndReload")}
                  </span>
                  <span className="ach-dropdown-item__badge ach-dropdown-item__badge--accent">
                    {t(locale, "popup.startAndReloadBadge")}
                  </span>
                </div>
                <p className="ach-dropdown-item__desc">
                  {t(locale, "popup.startAndReloadDesc")}
                </p>
              </button>
            </div>
          )}
        </div>

        <button className="ach-btn ach-btn--ghost" onClick={handleOpenSidePanel}>
          <PanelRightOpen size={14} />
          {t(locale, "popup.openSidePanel")}
        </button>
      </div>

      {message !== null && (
        <p className="ach-banner ach-banner--err ach-anim-in">
          <AlertTriangle size={14} />
          <span>{message}</span>
        </p>
      )}

      {active !== undefined && (
        <section className="ach-card ach-card--live ach-anim-in ach-anim-in-2" style={{ marginTop: 12 }}>
          <div className="ach-quality">
            <span className="ach-beacon ach-beacon--live" />
            <strong style={{ fontSize: 13 }}>{lifecycleLabel(active.lifecycle, locale)}</strong>
            <span
              className={
                active.captureQuality === "degraded" ? "ach-badge ach-badge--warn" : "ach-badge ach-badge--ok"
              }
            >
              {t(locale, "popup.captureQuality")} {qualityLabel(active.captureQuality, locale)}
            </span>
          </div>
          <div className="ach-stats">
            <div className="ach-stat">
              <div className="ach-stat-label">{t(locale, "popup.stepStat")}</div>
              <div className="ach-stat-value ach-stat-value--live">
                {snapshot === null ? "—" : String(snapshot.steps.length)}
              </div>
            </div>
            <div className="ach-stat">
              <div className="ach-stat-label">{t(locale, "popup.durationStat")}</div>
              <div className="ach-stat-value ach-stat-value--live">
                {formatDuration(Date.now() - active.startedAt)}
              </div>
            </div>
            <div className="ach-stat">
              <div className="ach-stat-label">{t(locale, "popup.sizeStat")}</div>
              <div className="ach-stat-value ach-stat-value--live">
                {snapshot === null
                  ? "—"
                  : formatBytes(snapshot.control.counters.totalLogicalBytes)}
              </div>
            </div>
          </div>
          <button
            className="ach-btn ach-btn--danger ach-btn--block"
            disabled={busy || stopping}
            onClick={handleStop(active.sessionId)}
          >
            <Square size={13} />
            {stopping ? t(locale, "popup.stoppingInProgress") : t(locale, "popup.stopRecording")}
          </button>
          {stopping && (
            <p className="ach-banner ach-banner--warn" style={{ marginTop: 8 }}>
              <span>
                {t(locale, "popup.collectingLateResponses")} ·
                {active.stopRequestedAt === undefined
                  ? ` ${t(locale, "popup.almostDone")}`
                  : ` ${tpl(locale, "popup.waitedOfMax", {
                      elapsed: ((nowMs - active.stopRequestedAt) / 1000).toFixed(1),
                      max: STOP_LATE_RESPONSE_WINDOW_MS / 1000,
                    })}`}{" "}
                · {tpl(locale, "popup.factsRecorded", { count: snapshot?.control.counters.factCount ?? "—" })}
              </span>
            </p>
          )}
        </section>
      )}

      <section className="ach-section ach-anim-in ach-anim-in-3">
        <div className="ach-section-head">
          <span className="ach-section-index">01</span>
          <h2 className="ach-section-title">{t(locale, "popup.sessionsTitle")}</h2>
          <span className="ach-section-meta">{sessions.length}</span>
        </div>
        {sessions.length === 0 ? (
          <p className="ach-empty">{t(locale, "popup.noSessions")}</p>
        ) : (
          <ul className="ach-list">
            {sessions.map((session) => (
              <li className="ach-session-row" key={session.sessionId}>
                <Activity size={12} style={{ flex: "none", color: "var(--ach-text-faint)" }} />
                <span className="ach-session-row-url" title={session.originUrl}>
                  {session.originUrl}
                </span>
                <span className="ach-session-row-meta">
                  {lifecycleLabel(session.lifecycle, locale)} /{" "}
                  {qualityLabel(session.captureQuality, locale)}
                </span>
                {DELETABLE_LIFECYCLES.has(session.lifecycle) && (
                  <button
                    className="ach-btn ach-btn--sm ach-btn--ghost"
                    disabled={busy}
                    aria-label={t(locale, "popup.deleteSession")}
                    title={t(locale, "popup.deleteSession")}
                    onClick={() => {
                      setDeleteCandidate(session);
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="ach-footnote ach-anim-in ach-anim-in-4">
        <ShieldAlert size={13} />
        <span>{t(locale, "popup.sensitiveDataNote")}</span>
      </p>

      <ConfirmDialog
        open={deleteCandidate !== null}
        title={t(locale, "delete.title")}
        message={t(locale, "delete.confirmMessage")}
        confirmLabel={t(locale, "delete.confirm")}
        cancelLabel={t(locale, "delete.cancel")}
        onConfirm={() => {
          if (deleteCandidate !== null) {
            setBusy(true);
            void deleteSession(deleteCandidate.sessionId)
              .then(async (result) => {
                if (!result.ok) {
                  setMessage(errorText(result.error));
                  return;
                }
                await refresh();
              })
              .finally(() => {
                setBusy(false);
              });
          }
          setDeleteCandidate(null);
        }}
        onCancel={() => {
          setDeleteCandidate(null);
        }}
      />
    </main>
  );
};
