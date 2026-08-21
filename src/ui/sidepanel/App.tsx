import { useCallback, useEffect, useState, type ReactElement } from "react";
import {
  Activity,
  AlertTriangle,
  Download,
  Layers,
  Play,
  ScanLine,
  Settings2,
  Square,
  Trash2,
} from "lucide-react";
import {
  deleteSession,
  exportSession,
  getAppSettings,
  getSessionSnapshot,
  getStepDetail,
  listSessions,
  resumeAfterStoragePressure,
  stopRecording,
  updateStepReview,
} from "../runtime-client";
import type { SessionLifecycle, SessionRecord } from "../../schemas/session";
import type { SessionSnapshot, StepDetail } from "../../shared/messages";
import type { Result } from "../../shared/errors";
import type { SessionId, StepId } from "../../shared/ids";
import { errorText, formatBytes, formatDuration, lifecycleLabel, qualityLabel } from "../format";
import { DEFAULT_LOCALE, t, tpl, type Locale } from "../../shared/i18n";
import { STOP_LATE_RESPONSE_WINDOW_MS } from "../../core/config";
import { CaptureQualityView } from "./CaptureQualityView";
import { ConfirmDialog } from "../ConfirmDialog";
import { SettingsPanel } from "./SettingsPanel";
import { StepCard } from "./StepCard";

/**
 * Side Panel (PRD 4.14): real-time, read-only inspection.
 *
 * Every visible value is rebuilt from repository snapshots fetched through
 * the message protocol. Nothing is derived from transient service-worker
 * memory, so closing and reopening the panel reproduces the same state — the
 * panel holds no truth of its own, only a selection and an expansion.
 */

const REFRESH_INTERVAL_MS = 1500;
/** Countdown tick for the stopping progress readout. */
const STOP_TICK_MS = 500;

/**
 * Lifecycles that may be deleted from the UI (crawler-13). Starting,
 * recording and stopping sessions are protected: recording loses live data,
 * stopping races the completion timer.
 */
const DELETABLE_LIFECYCLES: ReadonlySet<SessionLifecycle> = new Set([
  "completed",
  "interrupted",
  "paused_storage_pressure",
]);

type Tab = "timeline" | "settings";

export const App = (): ReactElement => {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<SessionId | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [expandedStepId, setExpandedStepId] = useState<StepId | null>(null);
  const [stepDetail, setStepDetail] = useState<StepDetail | null>(null);
  const [tab, setTab] = useState<Tab>("timeline");
  const [message, setMessage] = useState<string | null>(null);
  const [busySessionId, setBusySessionId] = useState<SessionId | null>(null);
  const [stopRequestSessionId, setStopRequestSessionId] = useState<SessionId | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  const [deleteCandidate, setDeleteCandidate] = useState<SessionRecord | null>(null);
  const busy = selectedSessionId !== null && busySessionId === selectedSessionId;

  const refreshSessions = useCallback(async (): Promise<SessionRecord[]> => {
    const result = await listSessions();
    if (!result.ok) {
      setMessage(errorText(result.error));
      return [];
    }
    setSessions(result.value);
    return result.value;
  }, []);

  const refreshSnapshot = useCallback(async (sessionId: SessionId): Promise<void> => {
    const result = await getSessionSnapshot(sessionId);
    if (result.ok) {
      setSnapshot(result.value);
    } else {
      setSnapshot(null);
      setMessage(errorText(result.error));
    }
  }, []);

  /** Poll the repository; selection persists, data always comes from storage. */
  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      const list = await refreshSessions();
      if (cancelled) {
        return;
      }
      const selected = selectedSessionId ?? list[0]?.sessionId ?? null;
      if (selected === null) {
        setSnapshot(null);
        return;
      }
      if (selectedSessionId === null) {
        setSelectedSessionId(selected);
      }
      await refreshSnapshot(selected);
    };
    void tick();
    const timer = setInterval(() => {
      void tick();
    }, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refreshSessions, refreshSnapshot, selectedSessionId]);

  /** Detail is fetched per expansion, never cached across steps. */
  useEffect(() => {
    if (expandedStepId === null) {
      setStepDetail(null);
      return;
    }
    let cancelled = false;
    void getStepDetail(expandedStepId).then((result) => {
      if (cancelled) {
        return;
      }
      if (result.ok) {
        setStepDetail(result.value);
      } else {
        setStepDetail(null);
        setMessage(errorText(result.error));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [expandedStepId, snapshot]);

  useEffect(() => {
    setBusySessionId(null);
    setStopRequestSessionId(null);
  }, [selectedSessionId]);

  /** Lightweight countdown ticker for the stopping progress readout. */
  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, STOP_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  /** Load the persisted UI language; this component owns the shared view state. */
  useEffect(() => {
    void getAppSettings().then((result) => {
      if (result.ok) {
        setLocale(result.value.locale ?? DEFAULT_LOCALE);
      }
    });
  }, []);

  const applyReview = (input: {
    stepId: StepId;
    excluded?: boolean;
    note?: string | null;
  }): void => {
    const requestSessionId = selectedSessionId;
    setBusySessionId(requestSessionId);
    void updateStepReview(input)
      .then(async (result) => {
        if (!result.ok) {
          setMessage(errorText(result.error));
          return;
        }
        if (selectedSessionId !== null) {
          await refreshSnapshot(selectedSessionId);
        }
      })
      .finally(() => {
        setBusySessionId((current) => (current === requestSessionId ? null : current));
      });
  };

  const runCommand = (
    action: () => Promise<Result<unknown>>,
    options: { readonly clearsSelection?: boolean } = {},
  ): void => {
    const requestSessionId = selectedSessionId;
    setBusySessionId(requestSessionId);
    void action()
      .then(async (result) => {
        if (!result.ok) {
          setMessage(errorText(result.error));
          return;
        }
        await refreshSessions();
        // A deleted session has no snapshot to re-read; asking for one would
        // surface a spurious SESSION_NOT_FOUND right after a successful action.
        if (options.clearsSelection !== true && selectedSessionId !== null) {
          await refreshSnapshot(selectedSessionId);
        }
      })
      .finally(() => {
        setBusySessionId((current) => (current === requestSessionId ? null : current));
      });
  };

  const requestStop = (sessionId: SessionId): void => {
    setBusySessionId(sessionId);
    setStopRequestSessionId(sessionId);
    void stopRecording(sessionId)
      .then(async (result) => {
        if (!result.ok) {
          setMessage(errorText(result.error));
          return;
        }
        await refreshSessions();
        if (selectedSessionId !== null) {
          await refreshSnapshot(selectedSessionId);
        }
      })
      .finally(() => {
        setBusySessionId((current) => (current === sessionId ? null : current));
        setStopRequestSessionId((current) => (current === sessionId ? null : current));
      });
  };

  const session = snapshot?.session ?? null;
  const stopping =
    session?.lifecycle === "stopping" ||
    (selectedSessionId !== null && stopRequestSessionId === selectedSessionId);

  return (
    <main className="ach-stage ach-shell-panel">
      <header className="ach-header-row">
        <div className="ach-brand">
          <span className="ach-brand-mark" aria-hidden="true">
            <ScanLine size={18} strokeWidth={2.2} />
          </span>
          <div>
            <div className="ach-brand-kicker">{t(locale, "sidepanel.kicker")}</div>
            <h1 className="ach-brand-title">{t(locale, "sidepanel.appTitle")}</h1>
          </div>
        </div>
        <nav className="ach-tabs" aria-label={t(locale, "sidepanel.timelineTab")}>
          <button
            className="ach-tab"
            disabled={tab === "timeline"}
            onClick={() => {
              setTab("timeline");
            }}
          >
            <Activity size={13} />
            {t(locale, "sidepanel.timelineTab")}
          </button>
          <button
            className="ach-tab"
            disabled={tab === "settings"}
            onClick={() => {
              setTab("settings");
            }}
          >
            <Settings2 size={13} />
            {t(locale, "sidepanel.settingsTab")}
          </button>
        </nav>
      </header>

      {message !== null && (
        <p className="ach-banner ach-banner--err">
          <AlertTriangle size={14} />
          <span>{message}</span>
        </p>
      )}
      {stopping && (
        <div data-testid="stop-feedback" className="ach-banner ach-banner--warn">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span>{t(locale, "sidepanel.stoppingFeedback")}</span>
            <span>
              {tpl(locale, "sidepanel.factsRecorded", {
                count: snapshot?.control.counters.factCount ?? "—",
              })}
            </span>
          </div>
          <div
            className="ach-stop-progress"
            role="progressbar"
            aria-label={t(locale, "sidepanel.stoppingFeedback")}
            aria-valuemin={0}
            aria-valuemax={STOP_LATE_RESPONSE_WINDOW_MS}
            aria-valuenow={Math.min(
              Math.max(0, nowMs - (session?.stopRequestedAt ?? nowMs)),
              STOP_LATE_RESPONSE_WINDOW_MS,
            )}
            style={{
              height: 6,
              marginTop: 8,
              borderRadius: 3,
              background: "var(--ach-surface-2)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${Math.min(
                  100,
                  (100 * Math.max(0, nowMs - (session?.stopRequestedAt ?? nowMs))) /
                    STOP_LATE_RESPONSE_WINDOW_MS,
                ).toFixed(1)}%`,
                background: "var(--ach-warn, #e6a23c)",
                transition: "width 0.5s linear",
              }}
            />
          </div>
        </div>
      )}

      {tab === "settings" ? (
        <SettingsPanel locale={locale} onLocaleChange={setLocale} />
      ) : (
        <>
          <label className="ach-field ach-anim-in">
            <span className="ach-label">
              {t(locale, "sidepanel.sessionLabel")}{" "}
              <span className="ach-label-mono">// session</span>
            </span>
            <select
              className="ach-select"
              value={selectedSessionId ?? ""}
              onChange={(event) => {
                const next = sessions.find(
                  (candidate) => candidate.sessionId === event.target.value,
                );
                setExpandedStepId(null);
                setSnapshot(null);
                setSelectedSessionId(next?.sessionId ?? null);
              }}
            >
              {sessions.length === 0 && (
                <option value="">{t(locale, "sidepanel.noSessionsOption")}</option>
              )}
              {sessions.map((candidate) => (
                <option key={candidate.sessionId} value={candidate.sessionId}>
                  {candidate.originUrl} — {lifecycleLabel(candidate.lifecycle, locale)} /{" "}
                  {qualityLabel(candidate.captureQuality, locale)}
                </option>
              ))}
            </select>
          </label>

          {snapshot === null || session === null ? (
            <p className="ach-empty">{t(locale, "sidepanel.selectSessionHint")}</p>
          ) : (
            <>
              <CaptureQualityView session={session} gaps={snapshot.gaps} locale={locale} />

              <p data-testid="session-counters" className="ach-counters">
                <span>
                  {t(locale, "sidepanel.stepsCounter")}{" "}
                  <b>{snapshot.steps.length}</b>
                </span>
                <span>
                  {t(locale, "sidepanel.factCounter")}{" "}
                  <b>{snapshot.control.counters.factCount}</b>
                </span>
                <span>
                  {t(locale, "sidepanel.sizeCounter")}{" "}
                  <b>{formatBytes(snapshot.control.counters.totalLogicalBytes)}</b>
                </span>
                <span>
                  {t(locale, "sidepanel.responseBodyCounter")}{" "}
                  <b>{formatBytes(snapshot.control.counters.responseBodyLogicalBytes)}</b>
                </span>
                <span>
                  {t(locale, "sidepanel.durationCounter")}{" "}
                  <b>
                    {formatDuration((session.stoppedAt ?? Date.now()) - session.startedAt)}
                  </b>
                </span>
              </p>

              <div className="ach-btn-row" style={{ marginBottom: 12 }}>
                {(session.lifecycle === "recording" || session.lifecycle === "interrupted") && (
                  <button
                    className="ach-btn ach-btn--danger"
                    disabled={busy}
                    onClick={() => {
                      requestStop(session.sessionId);
                    }}
                  >
                    <Square size={13} />
                    {t(locale, "sidepanel.stopRecording")}
                  </button>
                )}
                {session.lifecycle === "paused_storage_pressure" && (
                  <button
                    className="ach-btn ach-btn--primary"
                    disabled={busy}
                    onClick={() => {
                      runCommand(() => resumeAfterStoragePressure(session.sessionId));
                    }}
                  >
                    <Play size={13} />
                    {t(locale, "sidepanel.explicitResume")}
                  </button>
                )}
                {session.lifecycle === "completed" && (
                  <button
                    className="ach-btn ach-btn--primary"
                    disabled={busy}
                    onClick={() => {
                      runCommand(() => exportSession(session.sessionId, "zip"));
                    }}
                  >
                    <Download size={13} />
                    {t(locale, "sidepanel.exportZip")}
                  </button>
                )}
                {DELETABLE_LIFECYCLES.has(session.lifecycle) && (
                  <button
                    className="ach-btn ach-btn--danger"
                    disabled={busy}
                    onClick={() => {
                      setDeleteCandidate(session);
                    }}
                  >
                    <Trash2 size={13} />
                    {t(locale, "sidepanel.deleteSession")}
                  </button>
                )}
              </div>

              <div className="ach-section-head">
                <span className="ach-section-index">
                  <Layers size={10} />
                </span>
                <h2 className="ach-section-title">{t(locale, "sidepanel.timelineTitle")}</h2>
                <span className="ach-section-meta">
                  {tpl(locale, "sidepanel.timelineMeta", {
                    count: snapshot.steps.length,
                    excluded: snapshot.steps.filter((step) => step.excluded).length,
                  })}
                </span>
              </div>
              <ul className="ach-list">
                {snapshot.steps.map((step) => {
                  const id = step.stepId;
                  const expanded = expandedStepId === id;
                  return (
                    <StepCard
                      key={step.stepId}
                      step={step}
                      detail={expanded ? stepDetail : null}
                      expanded={expanded}
                      busy={busy}
                      locale={locale}
                      onToggle={() => {
                        setExpandedStepId(expanded ? null : id);
                      }}
                      onExcludedChange={(excluded) => {
                        applyReview({ stepId: id, excluded });
                      }}
                      onNoteSave={(note) => {
                        applyReview({ stepId: id, note });
                      }}
                    />
                  );
                })}
              </ul>
              {snapshot.steps.length === 0 && (
                <p className="ach-empty">{t(locale, "sidepanel.noSteps")}</p>
              )}
            </>
          )}
        </>
      )}

      <ConfirmDialog
        open={deleteCandidate !== null}
        title={t(locale, "delete.title")}
        message={t(locale, "delete.confirmMessage")}
        confirmLabel={t(locale, "delete.confirm")}
        cancelLabel={t(locale, "delete.cancel")}
        onConfirm={() => {
          if (deleteCandidate !== null) {
            setExpandedStepId(null);
            setSelectedSessionId(null);
            setSnapshot(null);
            runCommand(() => deleteSession(deleteCandidate.sessionId), {
              clearsSelection: true,
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
