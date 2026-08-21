import { useState, type ReactElement } from "react";
import { updateLocale } from "./runtime-client";
import { type Locale } from "../shared/i18n";

export interface LanguageSwitcherProps {
  readonly locale: Locale;
  readonly disabled?: boolean;
  readonly onLocaleChange: (locale: Locale) => void;
  readonly onErrorMessage?: (errorMsg: string) => void;
}

export const LanguageSwitcher = ({
  locale,
  disabled = false,
  onLocaleChange,
  onErrorMessage,
}: LanguageSwitcherProps): ReactElement => {
  const [busy, setBusy] = useState(false);

  const handleSwitch = (next: Locale): void => {
    if (next === locale || busy || disabled) {
      return;
    }
    setBusy(true);
    void updateLocale(next)
      .then((result) => {
        if (result.ok) {
          const updated = result.value.locale ?? next;
          onLocaleChange(updated);
        } else if (onErrorMessage) {
          onErrorMessage(result.error.message);
        }
      })
      .catch((error: unknown) => {
        if (onErrorMessage) {
          onErrorMessage(String(error));
        }
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div className="ach-lang-switcher" role="group" aria-label="Language">
      <button
        type="button"
        className={`ach-lang-btn${locale === "en" ? " ach-lang-btn--active" : ""}`}
        disabled={busy || disabled || locale === "en"}
        onClick={() => {
          handleSwitch("en");
        }}
      >
        EN
      </button>
      <button
        type="button"
        className={`ach-lang-btn${locale === "zh" ? " ach-lang-btn--active" : ""}`}
        disabled={busy || disabled || locale === "zh"}
        onClick={() => {
          handleSwitch("zh");
        }}
      >
        中文
      </button>
    </div>
  );
};
