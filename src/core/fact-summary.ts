import type { SealedStep } from "../schemas/step";
import type { DomLocators } from "../schemas/dom";
import type { StepId } from "../shared/ids";
import { DEFAULT_LOCALE, t, tpl, type Locale } from "../shared/i18n";

/**
 * Deterministic fact summary for a sealed Step (PRD 4.15, design 3.4).
 *
 * Hard contract:
 * - Same step + same locale + same template version ⇒ byte-identical output.
 *   No clock, no randomness, no locale-dependent formatting from the
 *   environment — the locale is an EXPLICIT input (crawler-12), so the same
 *   export always renders the same language.
 * - Every emitted field carries the `source` path of the raw record it came
 *   from, so a reader can always trace a summary line back to the fact.
 * - Extraction and counting only. This builder NEVER calls a model, never
 *   scans unrecorded page state, and never infers business meaning ("user
 *   logged in", "checkout succeeded" — all forbidden).
 *
 * Changing what a template emits REQUIRES bumping the version; the semantics
 * of an existing version are frozen so previously exported summaries stay
 * reproducible.
 */

export const FACT_SUMMARY_TEMPLATE_VERSION = 1;

/** Deterministic truncation so long text can never vary the output length. */
const MAX_TEXT_LENGTH = 80;
const ELLIPSIS = "…";

export interface FactSummaryField {
  readonly label: string;
  readonly value: string;
  /** Dot path into the raw record this value was read from. */
  readonly source: string;
}

export interface FactSummary {
  readonly templateVersion: number;
  readonly stepId: StepId;
  readonly ordinal: number;
  /** Single-line deterministic description. */
  readonly headline: string;
  readonly fields: readonly FactSummaryField[];
}

/** Minimal request projection the summary is allowed to read. */
export interface SummaryRequestFact {
  readonly requestKey: string;
  readonly statusCode?: number;
}

export interface FactSummaryInput {
  readonly step: SealedStep;
  /** Requests attributed to this step; only counts and status codes are used. */
  readonly requests?: readonly SummaryRequestFact[];
  /** Presentation language; explicit input so output is reproducible. */
  readonly locale?: Locale;
}

export const truncate = (text: string): string =>
  text.length <= MAX_TEXT_LENGTH ? text : `${text.slice(0, MAX_TEXT_LENGTH - 1)}${ELLIPSIS}`;

/** Collapse whitespace so captured text formats identically every time. */
const normalizeText = (text: string): string => truncate(text.replace(/\s+/gu, " ").trim());

/**
 * Fixed-priority target label. The order is part of the template contract —
 * reordering it changes output and therefore requires a version bump.
 */
export const targetLabel = (
  locators: DomLocators,
): { readonly value: string; readonly source: string } => {
  if (locators.ariaName !== undefined && locators.ariaName.trim() !== "") {
    return { value: normalizeText(locators.ariaName), source: "locators.ariaName" };
  }
  if (locators.visibleText !== undefined && locators.visibleText.trim() !== "") {
    return { value: normalizeText(locators.visibleText), source: "locators.visibleText" };
  }
  if (locators.id !== undefined && locators.id.trim() !== "") {
    return { value: normalizeText(locators.id), source: "locators.id" };
  }
  if (locators.name !== undefined && locators.name.trim() !== "") {
    return { value: normalizeText(locators.name), source: "locators.name" };
  }
  return { value: normalizeText(locators.cssSelector), source: "locators.cssSelector" };
};

/** "200×3, 404×1" — sorted numerically so the rendering is stable. */
export const statusCodeHistogram = (requests: readonly SummaryRequestFact[]): string => {
  const counts = new Map<number, number>();
  let unknown = 0;
  for (const request of requests) {
    if (request.statusCode === undefined) {
      unknown += 1;
      continue;
    }
    counts.set(request.statusCode, (counts.get(request.statusCode) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([code, count]) => `${String(code)}×${String(count)}`);
  if (unknown > 0) {
    // Unfinished/failed requests are reported, never counted as a success.
    parts.push(`no_status×${String(unknown)}`);
  }
  return parts.join(", ");
};

const domChangeField = (step: SealedStep, locale: Locale): FactSummaryField => {
  if (!step.domAfter.captured) {
    return {
      label: t(locale, "factSummary.domChange"),
      value: tpl(locale, "factSummary.domNotCaptured", { reason: step.domAfter.reason }),
      source: "step.domAfter.reason",
    };
  }
  const { added, updated, removed } = step.domAfter.mutationSummary;
  return {
    label: t(locale, "factSummary.domChange"),
    value: tpl(locale, "factSummary.domCounts", { added, updated, removed }),
    source: "step.domAfter.mutationSummary",
  };
};

const headlineOf = (step: SealedStep, locale: Locale): string => {
  switch (step.kind) {
    case "user_action": {
      const target = targetLabel(step.domBefore.locators);
      return tpl(locale, "factSummary.headline.userAction", {
        type: step.type,
        target: target.value,
      });
    }
    case "system_navigation": {
      const url = step.navigation.afterUrl;
      return url === ""
        ? tpl(locale, "factSummary.headline.navigation", { trigger: step.trigger })
        : tpl(locale, "factSummary.headline.navigationTo", { url: truncate(url) });
    }
    case "system_activity":
      return tpl(locale, "factSummary.headline.backgroundActivity", { trigger: step.trigger });
  }
};

/**
 * Build the summary. Pure: identical input yields an identical object, and
 * `JSON.stringify` of it is byte-identical across runs and runtimes.
 */
export const buildFactSummary = (input: FactSummaryInput): FactSummary => {
  const { step } = input;
  const locale = input.locale ?? DEFAULT_LOCALE;
  const requests = input.requests ?? [];
  const fields: FactSummaryField[] = [];

  if (step.kind === "user_action") {
    const target = targetLabel(step.domBefore.locators);
    fields.push({
      label: t(locale, "factSummary.actionType"),
      value: step.type,
      source: "step.type",
    });
    fields.push({
      label: t(locale, "factSummary.target"),
      value: target.value,
      source: `step.domBefore.${target.source}`,
    });
    fields.push({
      label: t(locale, "factSummary.selector"),
      value: truncate(step.domBefore.locators.cssSelector),
      source: "step.domBefore.locators.cssSelector",
    });
  } else if (step.kind === "system_navigation") {
    fields.push({ label: t(locale, "factSummary.actionType"), value: "system_navigation", source: "step.kind" });
    fields.push({ label: t(locale, "factSummary.trigger"), value: step.trigger, source: "step.trigger" });
    fields.push({
      label: t(locale, "factSummary.targetUrl"),
      value: truncate(step.navigation.afterUrl),
      source: "step.navigation.afterUrl",
    });
    fields.push({
      label: t(locale, "factSummary.sourceUrl"),
      value: truncate(step.navigation.beforeUrl),
      source: "step.navigation.beforeUrl",
    });
    fields.push({
      label: t(locale, "factSummary.navigationType"),
      value: step.navigation.navigationType,
      source: "step.navigation.navigationType",
    });
    fields.push({
      label: t(locale, "factSummary.redirectHops"),
      value: String(step.navigation.redirectChain.length),
      source: "step.navigation.redirectChain.length",
    });
  } else {
    fields.push({ label: t(locale, "factSummary.actionType"), value: "system_activity", source: "step.kind" });
    fields.push({ label: t(locale, "factSummary.trigger"), value: step.trigger, source: "step.trigger" });
  }

  fields.push({
    label: t(locale, "factSummary.requestCount"),
    value: String(step.requestKeys.length),
    source: "step.requestKeys.length",
  });
  const histogram = statusCodeHistogram(requests);
  if (histogram !== "") {
    fields.push({ label: t(locale, "factSummary.statusCodes"), value: histogram, source: "requests[].statusCode" });
  }
  fields.push(domChangeField(step, locale));
  fields.push({
    label: t(locale, "factSummary.storageDiffCount"),
    value: String(step.storageDiffIds.length),
    source: "step.storageDiffIds.length",
  });
  fields.push({
    label: t(locale, "factSummary.closeReason"),
    value: step.closeReason,
    source: "step.closeReason",
  });
  fields.push({
    label: t(locale, "factSummary.durationMs"),
    value: String(step.endedAt - step.startedAt),
    source: "step.endedAt - step.startedAt",
  });

  return {
    templateVersion: FACT_SUMMARY_TEMPLATE_VERSION,
    stepId: step.stepId,
    ordinal: step.ordinal,
    headline: headlineOf(step, locale),
    fields,
  };
};

/** Stable text rendering, used for export and for byte-equality assertions. */
export const renderFactSummary = (summary: FactSummary): string =>
  [
    `#${String(summary.ordinal)} ${summary.headline}`,
    ...summary.fields.map((field) => `  ${field.label}: ${field.value}`),
  ].join("\n");
