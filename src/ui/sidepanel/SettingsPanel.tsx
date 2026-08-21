import { useEffect, useState, type ReactElement } from "react";
import {
  Cookie,
  Filter,
  Gauge,
  Info,
  KeyRound,
  Plus,
  Save,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { getAppSettings, updateAppSettings } from "../runtime-client";
import type { AppSettings, SessionConfigPatch } from "../../schemas/settings";
import { sessionConfigPatchSchema } from "../../schemas/settings";
import {
  MANIFEST_PERMISSION_USAGE,
  OPTIONAL_HOST_PERMISSION_USAGE,
} from "../../shared/permissions";
import { errorText, formatBytes } from "../format";
import { t, tpl, type Locale } from "../../shared/i18n";

/**
 * Settings panel (PRD 4.14).
 *
 * These are DEFAULTS for new sessions. A running recording keeps the config it
 * started with, so nothing here can retroactively change how existing facts
 * were captured — the panel says so, rather than implying a live effect.
 *
 * The hard capacity guard is deliberately absent: it is not user-disableable.
 */

interface NumericField {
  readonly key: keyof Pick<
    SessionConfigPatch,
    | "responseBodySoftBudgetBytes"
    | "responseBodyMaxBytes"
    | "hoverDwellThresholdMs"
    | "networkQuietWindowMs"
    | "stepMaxWindowMs"
  >;
  readonly label: string;
  readonly hint: string;
  readonly unit: "bytes" | "ms";
}

const NUMERIC_FIELD_KEYS: Record<
  NumericField["key"],
  {
    readonly label:
      | "settings.field.responseBodySoftBudget"
      | "settings.field.responseBodyMax"
      | "settings.field.hoverDwell"
      | "settings.field.networkQuiet"
      | "settings.field.stepMaxWindow";
    readonly hint:
      | "settings.hint.responseBodySoftBudget"
      | "settings.hint.responseBodyMax"
      | "settings.hint.hoverDwell"
      | "settings.hint.networkQuiet"
      | "settings.hint.stepMaxWindow";
  }
> = {
  responseBodySoftBudgetBytes: {
    label: "settings.field.responseBodySoftBudget",
    hint: "settings.hint.responseBodySoftBudget",
  },
  responseBodyMaxBytes: {
    label: "settings.field.responseBodyMax",
    hint: "settings.hint.responseBodyMax",
  },
  hoverDwellThresholdMs: { label: "settings.field.hoverDwell", hint: "settings.hint.hoverDwell" },
  networkQuietWindowMs: { label: "settings.field.networkQuiet", hint: "settings.hint.networkQuiet" },
  stepMaxWindowMs: { label: "settings.field.stepMaxWindow", hint: "settings.hint.stepMaxWindow" },
};

/** Render-time resolution keeps labels/hints localized without rebuilding arrays. */
const numericFields = (locale: Locale): NumericField[] =>
  (
    [
      "responseBodySoftBudgetBytes",
      "responseBodyMaxBytes",
      "hoverDwellThresholdMs",
      "networkQuietWindowMs",
      "stepMaxWindowMs",
    ] as const
  ).map((key) => ({
    key,
    label: t(locale, NUMERIC_FIELD_KEYS[key].label),
    hint: t(locale, NUMERIC_FIELD_KEYS[key].hint),
    unit:
      key === "responseBodySoftBudgetBytes" || key === "responseBodyMaxBytes"
        ? "bytes"
        : "ms",
  }));

const FILTER_KINDS = ["domain", "url_regex", "method", "content_type"] as const;

interface SettingsPanelProps {
  readonly locale: Locale;
}

export const SettingsPanel = ({ locale }: SettingsPanelProps): ReactElement => {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [cookieDomains, setCookieDomains] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const result = await getAppSettings();
      if (cancelled) {
        return;
      }
      if (!result.ok) {
        setMessage(errorText(result.error));
        return;
      }
      applyLoaded(result.value);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const applyLoaded = (value: AppSettings): void => {
    setSettings(value);
    const config = value.defaultSessionConfig;
    setDrafts({
      responseBodySoftBudgetBytes: String(config.responseBodySoftBudgetBytes),
      responseBodyMaxBytes: String(config.responseBodyMaxBytes),
      hoverDwellThresholdMs: String(config.hoverDwellThresholdMs),
      networkQuietWindowMs: String(config.networkQuietWindowMs),
      stepMaxWindowMs: String(config.stepMaxWindowMs),
    });
    setCookieDomains(config.extraCookieDomains.join("\n"));
  };

  const save = (patch: SessionConfigPatch): void => {
    const parsed = sessionConfigPatchSchema.safeParse(patch);
    if (!parsed.success) {
      setMessage(`PROTOCOL_MESSAGE_INVALID：${t(locale, "settings.invalidConfig")}`);
      return;
    }
    setBusy(true);
    void updateAppSettings(parsed.data)
      .then((result) => {
        if (!result.ok) {
          setMessage(errorText(result.error));
          return;
        }
        applyLoaded(result.value);
        setMessage(t(locale, "settings.saved"));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const saveNumbers = (): void => {
    const values = new Map<NumericField["key"], number>();
    for (const field of numericFields(locale)) {
      const value = Number(drafts[field.key] ?? "");
      if (!Number.isInteger(value) || value <= 0) {
        setMessage(
          `PROTOCOL_MESSAGE_INVALID：${tpl(locale, "settings.fieldMustBePositive", { label: field.label })}`,
        );
        return;
      }
      values.set(field.key, value);
    }
    const read = (key: NumericField["key"]): number => values.get(key) ?? 0;
    save({
      responseBodySoftBudgetBytes: read("responseBodySoftBudgetBytes"),
      responseBodyMaxBytes: read("responseBodyMaxBytes"),
      hoverDwellThresholdMs: read("hoverDwellThresholdMs"),
      networkQuietWindowMs: read("networkQuietWindowMs"),
      stepMaxWindowMs: read("stepMaxWindowMs"),
    });
  };

  const saveCookieDomains = (): void => {
    const origins = cookieDomains
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const invalid = origins.filter((origin) => !isAbsoluteHttpUrl(origin));
    if (invalid.length > 0) {
      setMessage(
        `PROTOCOL_MESSAGE_INVALID：${tpl(locale, "settings.invalidOriginList", { list: invalid.join(", ") })}`,
      );
      return;
    }
    save({ extraCookieDomains: origins });
  };

  if (settings === null) {
    return (
      <section>
        <p className="ach-empty">{message ?? t(locale, "settings.loading")}</p>
      </section>
    );
  }

  const config = settings.defaultSessionConfig;

  return (
    <section data-testid="settings-panel" className="ach-anim-in">
      <p className="ach-banner ach-banner--info" style={{ marginTop: 0 }}>
        <Info size={14} />
        <span>{t(locale, "settings.defaultsNote")}</span>
      </p>
      {message !== null && (
        <p className="ach-banner ach-banner--ok">
          <span>{message}</span>
        </p>
      )}

      <div className="ach-section">
        <div className="ach-section-head">
          <span className="ach-section-index">01</span>
          <h3 className="ach-section-title">
            <Gauge size={11} style={{ marginRight: 5, verticalAlign: "-1px" }} />
            {t(locale, "settings.thresholdsTitle")}
          </h3>
        </div>
        {numericFields(locale).map((field) => (
          <div key={field.key} className="ach-field">
            <label className="ach-label">
              {field.label}
              {field.unit === "bytes" && (
                <span className="ach-label-mono">
                  {tpl(locale, "settings.currentValue", { value: formatBytes(config[field.key]) })}
                </span>
              )}
            </label>
            <input
              className="ach-input"
              value={drafts[field.key] ?? ""}
              inputMode="numeric"
              onChange={(event) => {
                setDrafts((previous) => ({ ...previous, [field.key]: event.target.value }));
              }}
            />
            <span className="ach-hint">{field.hint}</span>
          </div>
        ))}
        <button className="ach-btn ach-btn--primary ach-btn--sm" disabled={busy} onClick={saveNumbers}>
          <Save size={12} />
          {t(locale, "settings.thresholdsSave")}
        </button>
      </div>

      <div className="ach-section">
        <div className="ach-section-head">
          <span className="ach-section-index">02</span>
          <h3 className="ach-section-title">
            <Cookie size={11} style={{ marginRight: 5, verticalAlign: "-1px" }} />
            {t(locale, "settings.cookieTitle")}
          </h3>
        </div>
        <p className="ach-hint" style={{ marginTop: 0 }}>
          {t(locale, "settings.cookieHint")}
        </p>
        <div className="ach-field">
          <textarea
            className="ach-textarea"
            rows={3}
            value={cookieDomains}
            onChange={(event) => {
              setCookieDomains(event.target.value);
            }}
          />
        </div>
        <button
          className="ach-btn ach-btn--primary ach-btn--sm"
          disabled={busy}
          onClick={saveCookieDomains}
        >
          <Save size={12} />
          {t(locale, "settings.cookieSave")}
        </button>
      </div>

      <div className="ach-section">
        <div className="ach-section-head">
          <span className="ach-section-index">03</span>
          <h3 className="ach-section-title">
            <Filter size={11} style={{ marginRight: 5, verticalAlign: "-1px" }} />
            {t(locale, "settings.filtersTitle")}
          </h3>
        </div>
        <FilterRuleEditor
          rules={config.userFilterRules}
          busy={busy}
          locale={locale}
          onChange={(rules) => {
            save({ userFilterRules: rules });
          }}
        />
      </div>

      <div className="ach-section">
        <div className="ach-section-head">
          <span className="ach-section-index">04</span>
          <h3 className="ach-section-title">
            <KeyRound size={11} style={{ marginRight: 5, verticalAlign: "-1px" }} />
            {t(locale, "settings.permissionsTitle")}
          </h3>
        </div>
        <ul className="ach-datalist">
          {MANIFEST_PERMISSION_USAGE.map((usage) => (
            <li key={usage.permission} style={{ marginBottom: 4 }}>
              <code>{usage.permission}</code>
              <br />
              <span style={{ color: "var(--ach-text-faint)" }}>{usage.usagePath}</span>
            </li>
          ))}
        </ul>
        <h4 className="ach-subsection-title" style={{ marginTop: 10 }}>
          {t(locale, "settings.permissionsSubtitle")}
        </h4>
        <ul className="ach-datalist">
          {OPTIONAL_HOST_PERMISSION_USAGE.map((usage) => (
            <li key={usage.permission} style={{ marginBottom: 4 }}>
              <code>{usage.permission}</code>
              <br />
              <span style={{ color: "var(--ach-text-faint)" }}>{usage.usagePath}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="ach-section">
        <div className="ach-section-head">
          <span className="ach-section-index">05</span>
          <h3 className="ach-section-title">
            <ShieldAlert size={11} style={{ marginRight: 5, verticalAlign: "-1px" }} />
            {t(locale, "settings.riskTitle")}
          </h3>
        </div>
        <div className="ach-banner ach-banner--warn" style={{ margin: 0 }}>
          <ShieldAlert size={14} />
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            <li>{t(locale, "settings.riskCookies")}</li>
            <li>{t(locale, "settings.riskProtectedPages")}</li>
            <li>{t(locale, "settings.riskUnauthorizedOrigins")}</li>
            <li>{t(locale, "settings.riskDebugBanner")}</li>
          </ul>
        </div>
      </div>
    </section>
  );
};

interface FilterRule {
  readonly ruleId: string;
  readonly kind: (typeof FILTER_KINDS)[number];
  readonly pattern: string;
}

const FilterRuleEditor = ({
  rules,
  busy,
  locale,
  onChange,
}: {
  readonly rules: readonly FilterRule[];
  readonly busy: boolean;
  readonly locale: Locale;
  readonly onChange: (rules: FilterRule[]) => void;
}): ReactElement => {
  const [kind, setKind] = useState<(typeof FILTER_KINDS)[number]>("domain");
  const [pattern, setPattern] = useState("");

  return (
    <div>
      <p className="ach-hint" style={{ marginTop: 0 }}>
        {t(locale, "settings.filterHint")}
      </p>
      <ul className="ach-datalist" style={{ marginBottom: 8 }}>
        {rules.length === 0 && <li className="ach-empty">{t(locale, "settings.noRules")}</li>}
        {rules.map((rule) => (
          <li
            key={rule.ruleId}
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <code>{rule.kind}</code>
            <span style={{ flex: 1, minWidth: 0 }}>{rule.pattern}</span>
            <button
              className="ach-btn ach-btn--sm ach-btn--ghost"
              disabled={busy}
              onClick={() => {
                onChange(rules.filter((candidate) => candidate.ruleId !== rule.ruleId));
              }}
            >
              <Trash2 size={11} />
              {t(locale, "settings.deleteRule")}
            </button>
          </li>
        ))}
      </ul>
      <div style={{ display: "flex", gap: 6 }}>
        <select
          className="ach-select"
          style={{ width: "auto", flex: "none" }}
          value={kind}
          onChange={(event) => {
            const next = FILTER_KINDS.find((candidate) => candidate === event.target.value);
            if (next !== undefined) {
              setKind(next);
            }
          }}
        >
          {FILTER_KINDS.map((candidate) => (
            <option key={candidate} value={candidate}>
              {candidate}
            </option>
          ))}
        </select>
        <input
          className="ach-input"
          style={{ flex: 1 }}
          value={pattern}
          placeholder={t(locale, "settings.patternPlaceholder")}
          onChange={(event) => {
            setPattern(event.target.value);
          }}
        />
        <button
          className="ach-btn ach-btn--sm"
          disabled={busy || pattern.trim() === ""}
          onClick={() => {
            onChange([
              ...rules,
              { ruleId: `user-${String(rules.length + 1)}-${kind}`, kind, pattern: pattern.trim() },
            ]);
            setPattern("");
          }}
        >
          <Plus size={12} />
          {t(locale, "settings.addRule")}
        </button>
      </div>
    </div>
  );
};

const isAbsoluteHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};
