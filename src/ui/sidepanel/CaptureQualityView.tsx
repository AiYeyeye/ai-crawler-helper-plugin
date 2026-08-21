import type { ReactElement } from "react";
import { ShieldCheck } from "lucide-react";
import type { CaptureGapRecord } from "../../schemas/capture-gap";
import type { SessionRecord } from "../../schemas/session";
import { formatTimestamp, gapReasonLabel, lifecycleLabel, qualityLabel } from "../format";
import { t, tpl, type Locale } from "../../shared/i18n";

/**
 * Capture quality view (design 4.1).
 *
 * Lifecycle and quality are shown as two independent axes on purpose: a
 * `degraded` session is still a real, inspectable, exportable recording — a
 * blind spot is never dressed up as a lifecycle failure, and never as normal
 * data. All copy is localized (crawler-12); the term for a capture gap is
 * 盲区 / blind spot.
 */

export interface CaptureQualityViewProps {
  readonly session: SessionRecord;
  readonly gaps: readonly CaptureGapRecord[];
  readonly locale: Locale;
}

const scopeText = (gap: CaptureGapRecord, locale: Locale): string => {
  const parts: string[] = [];
  parts.push(`${t(locale, "cq.scopeCollector")} ${gap.scope.collector ?? "all"}`);
  if (gap.scope.tabId !== undefined) {
    parts.push(`${t(locale, "cq.scopeTab")} ${String(gap.scope.tabId)}`);
  }
  if (gap.scope.frameId !== undefined) {
    parts.push(`${t(locale, "cq.scopeFrame")} ${String(gap.scope.frameId)}`);
  }
  if (gap.scope.documentId !== undefined) {
    parts.push(`${t(locale, "cq.scopeDocument")} ${gap.scope.documentId}`);
  }
  if (gap.scope.cdpTarget?.targetId !== undefined) {
    parts.push(`${t(locale, "cq.scopeTarget")} ${gap.scope.cdpTarget.targetId}`);
  }
  if (gap.scope.cdpTarget?.sessionId !== undefined) {
    parts.push(`${t(locale, "cq.scopeCdpSession")} ${gap.scope.cdpTarget.sessionId}`);
  }
  if (gap.scope.cdpTarget?.attachEpoch !== undefined) {
    parts.push(`${t(locale, "cq.scopeAttachEpoch")} ${String(gap.scope.cdpTarget.attachEpoch)}`);
  }
  return parts.join(" · ");
};

const terminalActions = new Set([
  "target_destroyed",
  "session_stopped",
  "collector_disconnected",
]);

const gapResolution = (gap: CaptureGapRecord): "open" | "recovered" | "terminal" => {
  if (gap.recovery !== undefined && terminalActions.has(gap.recovery.action)) {
    return "terminal";
  }
  return gap.observedEndedAt === undefined ? "open" : "recovered";
};

const recoveryText = (gap: CaptureGapRecord, locale: Locale): string => {
  if (gap.recovery === undefined) {
    return gap.recoverable
      ? t(locale, "cq.recoverablePending")
      : t(locale, "cq.unrecoverable");
  }
  const recoveredAt =
    gap.recovery.recoveredAt === undefined
      ? ""
      : `（${formatTimestamp(gap.recovery.recoveredAt)}）`;
  switch (gap.recovery.action) {
    case "target_destroyed":
      return `${t(locale, "cq.terminatedTargetDestroyed")}${recoveredAt}`;
    case "session_stopped":
      return `${t(locale, "cq.terminatedSessionStopped")}${recoveredAt}`;
    case "collector_disconnected":
      return `${t(locale, "cq.terminatedCollectorDisconnected")}${recoveredAt}`;
    default:
      return tpl(locale, "cq.recoveredAction", { action: gap.recovery.action }) + recoveredAt;
  }
};

export const CaptureQualityView = ({
  session,
  gaps,
  locale,
}: CaptureQualityViewProps): ReactElement => {
  const open = gaps.filter((gap) => gap.observedEndedAt === undefined);
  return (
    <section data-testid="capture-quality" className="ach-card" style={{ marginBottom: 10 }}>
      <div className="ach-quality">
        <span className="ach-quality-label">{t(locale, "sidepanel.lifecycleAxis")}</span>
        <span className="ach-badge">{lifecycleLabel(session.lifecycle, locale)}</span>
        <span className="ach-quality-label">{t(locale, "sidepanel.captureQualityAxis")}</span>
        <span
          data-testid="capture-quality-value"
          className={
            session.captureQuality === "degraded" ? "ach-badge ach-badge--warn" : "ach-badge ach-badge--ok"
          }
        >
          {qualityLabel(session.captureQuality, locale)}
        </span>
      </div>
      {gaps.length === 0 ? (
        <p className="ach-empty" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <ShieldCheck size={12} style={{ color: "var(--ach-green)" }} />
          {t(locale, "cq.noBlindSpots")}
        </p>
      ) : (
        <>
          <p className="ach-banner ach-banner--warn" style={{ margin: "4px 0 8px" }}>
            <span>
              {tpl(locale, "cq.summary", { total: gaps.length, open: open.length })}
            </span>
          </p>
          <ul className="ach-list">
            {gaps.map((gap) => (
              <li
                key={gap.gapId}
                data-testid="capture-gap"
                data-gap-resolution={gapResolution(gap)}
                className="ach-gap"
              >
                <div className="ach-gap-title">
                  {gapReasonLabel(gap.reason, locale)}
                  {" · "}
                  {formatTimestamp(gap.observedStartedAt)} →{" "}
                  {gap.observedEndedAt === undefined
                    ? t(locale, "cq.inProgress")
                    : formatTimestamp(gap.observedEndedAt)}
                  {gap.boundaryConfidence === "estimated" && t(locale, "cq.estimatedBoundary")}
                </div>
                <div className="ach-gap-meta">
                  {scopeText(gap, locale)} · {t(locale, "cq.affectedCapabilities")}{" "}
                  {gap.affectedCapabilities.join("/")} · {recoveryText(gap, locale)}
                </div>
                {gap.detail !== undefined && <div className="ach-gap-detail">{gap.detail}</div>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
};
