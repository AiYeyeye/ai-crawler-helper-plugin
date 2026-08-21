import { useEffect, useState, type ReactElement } from "react";
import { Ban, ChevronRight, Eraser, RotateCcw, Save } from "lucide-react";
import { buildFactSummary, renderFactSummary, type FactSummary } from "../../core/fact-summary";
import type { StepDetail } from "../../shared/messages";
import type { StoredStep } from "../../schemas/step";
import type { ResponseBodyResult } from "../../schemas/network";
import { isSealedStep } from "../../schemas/step";
import { formatBytes, formatDuration, formatTimestamp } from "../format";
import { t, tpl, type Locale } from "../../shared/i18n";

export interface StepCardProps {
  readonly step: StoredStep;
  readonly detail: StepDetail | null;
  readonly expanded: boolean;
  readonly busy: boolean;
  readonly locale: Locale;
  readonly onToggle: () => void;
  readonly onExcludedChange: (excluded: boolean) => void;
  readonly onNoteSave: (note: string | null) => void;
}

const headlineFor = (step: StoredStep, locale: Locale): string =>
  isSealedStep(step)
    ? buildFactSummary({ step, locale }).headline
    : `#${String(step.ordinal)} ${step.kind}`;

const summaryFor = (step: StoredStep, locale: Locale): FactSummary | null =>
  isSealedStep(step) ? buildFactSummary({ step, locale }) : null;

export const StepCard = ({
  step,
  detail,
  expanded,
  busy,
  locale,
  onToggle,
  onExcludedChange,
  onNoteSave,
}: StepCardProps): ReactElement => {
  const [noteDraft, setNoteDraft] = useState(step.note ?? "");

  // The repository snapshot is the source of truth: a note edited elsewhere
  // (or reverted by a rejected write) reappears here on the next refresh.
  useEffect(() => {
    setNoteDraft(step.note ?? "");
  }, [step.stepId, step.note]);

  const summary = expanded ? summaryFor(step, locale) : null;
  const sealed = isSealedStep(step);

  const stepClass = step.excluded
    ? "ach-step ach-step--excluded"
    : sealed
      ? "ach-step ach-step--sealed"
      : "ach-step ach-step--open";

  return (
    <li
      data-testid="step-card"
      data-step-id={step.stepId}
      data-excluded={String(step.excluded)}
      className={stepClass}
    >
      <div className="ach-step-head">
        <button className="ach-step-toggle" onClick={onToggle} aria-expanded={expanded}>
          <ChevronRight size={13} className="ach-step-chevron" />
          <span className="ach-step-ordinal">#{step.ordinal}</span>
          <span className="ach-step-headline">{headlineFor(step, locale)}</span>
        </button>
        <span className={sealed ? "ach-badge ach-badge--ok" : "ach-badge ach-badge--live"}>
          {sealed ? t(locale, "stepCard.sealed") : t(locale, "stepCard.open")}
        </span>
        {step.excluded && <span className="ach-badge ach-badge--err">{t(locale, "stepCard.excluded")}</span>}
      </div>

      <div className="ach-step-meta">
        {tpl(locale, "stepCard.meta", {
          time: formatTimestamp(step.startedAt),
          requests: step.requestKeys.length,
          storage: step.storageDiffIds.length,
          duration: "",
        })}
        {sealed &&
          tpl(locale, "stepCard.metaDuration", {
            duration: formatDuration(step.endedAt - step.startedAt),
          })}
      </div>

      {expanded && (
        <div className="ach-step-body">
          {summary === null ? (
            <p className="ach-empty">{t(locale, "stepCard.notFinalized")}</p>
          ) : (
            <FactSummaryTable summary={summary} locale={locale} />
          )}

          {detail !== null && <RawFactSections detail={detail} locale={locale} />}

          <div className="ach-subsection">
            <label className="ach-label">
              {t(locale, "stepCard.noteLabel")}{" "}
              <span className="ach-label-mono">// {t(locale, "stepCard.noteStoredSeparately")}</span>
            </label>
            <textarea
              className="ach-textarea"
              value={noteDraft}
              rows={2}
              onChange={(event) => {
                setNoteDraft(event.target.value);
              }}
            />
            <div className="ach-btn-row" style={{ marginTop: 6 }}>
              <button
                className="ach-btn ach-btn--sm"
                disabled={busy}
                onClick={() => {
                  onNoteSave(noteDraft.trim() === "" ? null : noteDraft);
                }}
              >
                <Save size={12} />
                {t(locale, "stepCard.saveNote")}
              </button>
              <button
                className="ach-btn ach-btn--sm ach-btn--ghost"
                disabled={busy || step.note === undefined}
                onClick={() => {
                  onNoteSave(null);
                }}
              >
                <Eraser size={12} />
                {t(locale, "stepCard.clearNote")}
              </button>
              <button
                className={
                  step.excluded
                    ? "ach-btn ach-btn--sm"
                    : "ach-btn ach-btn--sm ach-btn--danger"
                }
                disabled={busy}
                onClick={() => {
                  onExcludedChange(!step.excluded);
                }}
              >
                {step.excluded ? <RotateCcw size={12} /> : <Ban size={12} />}
                {step.excluded ? t(locale, "stepCard.restoreStep") : t(locale, "stepCard.excludeStep")}
              </button>
            </div>
            <p className="ach-hint">{t(locale, "stepCard.excludeHint")}</p>
          </div>
        </div>
      )}
    </li>
  );
};

const FactSummaryTable = ({
  summary,
  locale,
}: {
  readonly summary: FactSummary;
  readonly locale: Locale;
}): ReactElement => (
  <section data-testid="fact-summary" className="ach-subsection" style={{ marginTop: 0 }}>
    <h4 className="ach-subsection-title">
      {t(locale, "stepCard.factSummaryTitle")} · v{summary.templateVersion}
    </h4>
    <pre className="ach-codeblock" data-testid="fact-summary-text">
      {renderFactSummary(summary)}
    </pre>
    <table className="ach-table">
      <thead>
        <tr>
          <th>{t(locale, "stepCard.tableField")}</th>
          <th>{t(locale, "stepCard.tableValue")}</th>
          <th>{t(locale, "stepCard.tableSource")}</th>
        </tr>
      </thead>
      <tbody>
        {summary.fields.map((field) => (
          <tr key={`${field.label}:${field.source}`}>
            <td>{field.label}</td>
            <td>{field.value}</td>
            <td style={{ color: "var(--ach-text-faint)" }}>{field.source}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </section>
);

const RawFactSections = ({
  detail,
  locale,
}: {
  readonly detail: StepDetail;
  readonly locale: Locale;
}): ReactElement => (
  <>
    <section className="ach-subsection">
      <h4 className="ach-subsection-title">
        {t(locale, "stepCard.requestsTitle")} · {detail.requests.length}
      </h4>
      {detail.requests.length === 0 ? (
        <p className="ach-empty">{t(locale, "stepCard.noRequests")}</p>
      ) : (
        <ul className="ach-datalist">
          {detail.requests.map((request) => (
            <li key={request.requestKey}>
              <code>{request.method}</code> {request.url}
              {" — "}
              {request.statusCode === undefined
                ? request.failure === undefined
                  ? t(locale, "stepCard.requestIncomplete")
                  : tpl(locale, "stepCard.requestFailed", {
                      text: request.failure.errorText,
                    })
                : String(request.statusCode)}
              {request.responseBody !== undefined &&
                tpl(locale, "stepCard.bodySuffix", {
                  label: responseBodyLabel(request.responseBody, locale),
                })}
            </li>
          ))}
        </ul>
      )}
    </section>

    <section className="ach-subsection">
      <h4 className="ach-subsection-title">
        {t(locale, "stepCard.storageTitle")} · {detail.storageDiffs.length}
      </h4>
      {detail.storageDiffs.length === 0 ? (
        <p className="ach-empty">{t(locale, "stepCard.noStorage")}</p>
      ) : (
        <ul className="ach-datalist">
          {detail.storageDiffs.map((diff) => (
            <li key={diff.storageRecordId}>
              {tpl(locale, "stepCard.storageSummary", {
                added: diff.added.length,
                updated: diff.updated.length,
                removed: diff.removed.length,
                time: formatTimestamp(diff.recordedAt),
              })}
            </li>
          ))}
        </ul>
      )}
    </section>

    <section className="ach-subsection">
      <h4 className="ach-subsection-title">{t(locale, "stepCard.domTitle")}</h4>
      <DomSection detail={detail} locale={locale} />
    </section>
  </>
);

const DomSection = ({
  detail,
  locale,
}: {
  readonly detail: StepDetail;
  readonly locale: Locale;
}): ReactElement => {
  const step = detail.step;
  if (!isSealedStep(step)) {
    return <p className="ach-empty">{t(locale, "stepCard.domNotSealed")}</p>;
  }
  if (!step.domAfter.captured) {
    return (
      <p className="ach-empty">
        {tpl(locale, "stepCard.domNotCaptured", { reason: step.domAfter.reason })}
      </p>
    );
  }
  const { added, updated, removed } = step.domAfter.mutationSummary;
  return (
    <p className="ach-empty" style={{ color: "var(--ach-text-dim)" }}>
      {tpl(locale, "stepCard.domSummary", {
        added,
        updated,
        removed,
        count: step.domRecordIds.length,
      })}
    </p>
  );
};

/**
 * Response-body availability, always explicit. An unavailable body is never
 * rendered as an empty one (design 15: no faking a missing body as success).
 */
const responseBodyLabel = (body: ResponseBodyResult, locale: Locale): string => {
  switch (body.kind) {
    case "captured":
      return tpl(locale, "stepCard.bodyCaptured", { size: formatBytes(body.byteLength) });
    case "filtered":
      return tpl(locale, "stepCard.bodyFiltered", { rule: body.ruleId });
    case "too_large":
      return tpl(locale, "stepCard.bodyTooLarge", {
        size: formatBytes(body.byteLength),
        limit: formatBytes(body.limitBytes),
      });
    case "binary_metadata_only":
      return tpl(locale, "stepCard.bodyBinary", { mime: body.mimeType ?? "unknown" });
    case "unavailable":
      return tpl(locale, "stepCard.bodyUnavailable", { reason: body.reason });
    case "missing_due_to_gap":
      return tpl(locale, "stepCard.bodyGap", { id: body.gapId });
  }
};
