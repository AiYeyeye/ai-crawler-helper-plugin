import type { SessionLifecycle } from "../schemas/session";
import type { CaptureQuality } from "../schemas/common";
import type { BusinessError } from "../shared/errors";
import type { CaptureGapReason } from "../schemas/capture-gap";
import { t, type Locale } from "../shared/i18n";

/**
 * Presentation helpers shared by Popup and Side Panel.
 *
 * Formatting only — nothing here derives a fact. Lifecycle and capture
 * quality are rendered as two independent axes (design 4.1): a degraded
 * session is still `recording`, and a complete session can still be stopped.
 * All labels are localized through the i18n dictionary (crawler-12).
 */

export const lifecycleLabel = (lifecycle: SessionLifecycle, locale: Locale): string =>
  t(locale, `format.lifecycle.${lifecycle}` as const);

export const qualityLabel = (quality: CaptureQuality, locale: Locale): string =>
  t(locale, quality === "degraded" ? "format.quality.degraded" : "format.quality.complete");

export const gapReasonLabel = (reason: CaptureGapReason, locale: Locale): string =>
  t(locale, `format.gapReason.${reason}` as const);

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB"] as const;

/** Binary units with one decimal; deterministic, locale-independent. */
export const formatBytes = (bytes: number): string => {
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = BYTE_UNITS[unitIndex] ?? "B";
  return unitIndex === 0 ? `${String(bytes)} ${unit}` : `${value.toFixed(1)} ${unit}`;
};

/** `1h 02m 03s` / `02m 03s` / `3.4s`. Locale-independent by construction. */
export const formatDuration = (milliseconds: number): string => {
  if (milliseconds < 0) {
    return "—";
  }
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  if (hours > 0) {
    return `${String(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
  }
  if (minutes > 0) {
    return `${pad(minutes)}m ${pad(seconds)}s`;
  }
  return `${(milliseconds / 1000).toFixed(1)}s`;
};

/** Epoch ms as a stable `YYYY-MM-DD HH:mm:ss` in the viewer's local zone. */
export const formatTimestamp = (epochMs: number): string => {
  const date = new Date(epochMs);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
};

/**
 * User-visible error text. The business code is always shown so a report can
 * be matched to a rule; the raw cause never crosses the boundary (design 14).
 */
export const errorText = (error: BusinessError): string => {
  const text = `${error.code}：${error.message}`;
  const cause = error.code === "DEBUGGER_ATTACH_FAILED" ? error.details?.cause : undefined;
  return typeof cause === "string" ? `${text}（${cause}）` : text;
};
