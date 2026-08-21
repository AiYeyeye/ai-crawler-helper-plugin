import { buildFactSummary } from "../core/fact-summary";
import type { SessionExportData } from "../persistence/export-readback";
import { isSealedStep } from "../schemas/step";
import { t, tpl, type Locale } from "../shared/i18n";

/**
 * Builds workflow-prompt.md (design 13, crawler-12 v2 structure).
 *
 * Section order is fixed and user-confirmed:
 *   1. Agent Instructions  — what the agent must do, first
 *   2. Export Package Guide — fixed template text: package layout + terminology
 *   3. Session Overview / 4. Navigation Flow / 5. Steps / 6. Blind Spots
 *
 * Localized per the export's locale snapshot; data contract values (stepId,
 * kind, URLs, status codes) are never translated.
 */

const MAX_URL_LENGTH = 120;

const truncateUrl = (url: string): string =>
  url.length <= MAX_URL_LENGTH ? url : `${url.slice(0, MAX_URL_LENGTH - 1)}…`;

const formatDuration = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}m ${String(seconds).padStart(2, "0")}s`;
};

/** First attributed request URL for a step, or null when none exist. */
const firstRequestUrl = (
  data: SessionExportData,
  requestKeys: readonly string[],
): string | null => {
  const wanted = new Set(requestKeys);
  const first = data.requests.find((request) => wanted.has(request.requestKey));
  return first === undefined ? null : truncateUrl(first.url);
};

export const buildWorkflowPrompt = (data: SessionExportData, locale: Locale): string => {
  const lines: string[] = [];

  // -------------------------------------------------------------------------
  // 1. Agent Instructions
  // -------------------------------------------------------------------------
  lines.push(`# ${t(locale, "prompt.title")}`);
  lines.push(``);
  lines.push(`## 1. ${t(locale, "prompt.instructionsTitle")}`);
  lines.push(``);
  lines.push(`- ${t(locale, "prompt.instructionsIntro")}`);
  lines.push(`- ${t(locale, "prompt.instructionsOrder")}`);
  lines.push(`- ${t(locale, "prompt.instructionsEvidence")}`);
  lines.push(`- ${t(locale, "prompt.instructionsCredentials")}`);
  lines.push(``);

  // -------------------------------------------------------------------------
  // 2. Export Package Guide (fixed template text)
  // -------------------------------------------------------------------------
  lines.push(`## 2. ${t(locale, "prompt.packageTitle")}`);
  lines.push(``);
  lines.push(`### 2.1 ${t(locale, "prompt.packageStructureTitle")}`);
  lines.push(``);
  lines.push(t(locale, "prompt.packageStructureIntro"));
  lines.push(``);
  lines.push(`- ${t(locale, "prompt.packageStructure.steps")}`);
  lines.push(`- ${t(locale, "prompt.packageStructure.excluded")}`);
  lines.push(`- ${t(locale, "prompt.packageStructure.contextIndex")}`);
  lines.push(`- ${t(locale, "prompt.packageStructure.manifest")}`);
  lines.push(`- ${t(locale, "prompt.packageStructure.captureGaps")}`);
  lines.push(`- ${t(locale, "prompt.packageStructure.storage")}`);
  lines.push(`- ${t(locale, "prompt.packageStructure.workflow")}`);
  lines.push(`- ${t(locale, "prompt.packageStructure.har")}`);
  lines.push(``);
  lines.push(`### 2.2 ${t(locale, "prompt.terminologyTitle")}`);
  lines.push(``);
  lines.push(`- ${t(locale, "prompt.term.step")}`);
  lines.push(`- ${t(locale, "prompt.term.blindSpot")}`);
  lines.push(`- ${t(locale, "prompt.term.navigation")}`);
  lines.push(`- ${t(locale, "prompt.term.request")}`);
  lines.push(`- ${t(locale, "prompt.term.storageDiff")}`);
  lines.push(`- ${t(locale, "prompt.term.excluded")}`);
  lines.push(``);
  lines.push(`### 2.3 ${t(locale, "prompt.lineageTitle")}`);
  lines.push(``);
  lines.push(t(locale, "prompt.lineageIntro"));
  lines.push(``);
  lines.push(t(locale, "prompt.lineageAuth"));
  lines.push(t(locale, "prompt.lineageParams"));
  lines.push(t(locale, "prompt.lineageNoise"));
  lines.push(``);

  // -------------------------------------------------------------------------
  // 3. Session Overview
  // -------------------------------------------------------------------------
  const session = data.session;
  const startedAt = new Date(session.startedAt).toISOString();
  const stoppedAt =
    session.stoppedAt === undefined ? "—" : new Date(session.stoppedAt).toISOString();
  lines.push(`## 3. ${t(locale, "prompt.overviewTitle")}`);
  lines.push(``);
  lines.push(`- ${t(locale, "prompt.overview.sessionId")}: \`${session.sessionId}\``);
  lines.push(`- ${t(locale, "prompt.overview.targetUrl")}: ${session.originUrl}`);
  lines.push(`- ${t(locale, "prompt.overview.timeRange")}: ${startedAt} → ${stoppedAt}`);
  lines.push(
    `- ${t(locale, "prompt.overview.duration")}: ${formatDuration(
      (session.stoppedAt ?? Date.now()) - session.startedAt,
    )}`,
  );
  lines.push(`- ${t(locale, "prompt.overview.steps")}: ${String(data.steps.length)}`);
  const qualityKey =
    session.captureQuality === "degraded"
      ? ("format.quality.degraded" as const)
      : ("format.quality.complete" as const);
  lines.push(`- ${t(locale, "prompt.overview.quality")}: ${t(locale, qualityKey)}`);
  lines.push(`- ${t(locale, "prompt.overview.blindSpots")}: ${String(data.captureGaps.length)}`);
  lines.push(``);

  // -------------------------------------------------------------------------
  // 4. Navigation Flow
  // -------------------------------------------------------------------------
  lines.push(`## 4. ${t(locale, "prompt.navigationTitle")}`);
  lines.push(``);
  lines.push(t(locale, "prompt.navigationIntro"));
  lines.push(``);
  if (data.navigations.length === 0) {
    lines.push("- —");
  } else {
    data.navigations.forEach((navigation, index) => {
      const from = navigation.beforeUrl === "" ? "—" : truncateUrl(navigation.beforeUrl);
      const to = navigation.afterUrl === "" ? "—" : truncateUrl(navigation.afterUrl);
      lines.push(`- ${tpl(locale, "prompt.navigationEntry", { index: index + 1, from, to })}`);
    });
  }
  lines.push(``);

  // -------------------------------------------------------------------------
  // 5. Steps
  // -------------------------------------------------------------------------
  lines.push(`## 5. ${t(locale, "prompt.stepsTitle")}`);
  lines.push(``);
  lines.push(t(locale, "prompt.stepsIntro"));
  lines.push(``);

  let stepIndex = 0;
  for (const step of data.steps) {
    if (!isSealedStep(step)) {
      continue;
    }
    stepIndex += 1;
    const summary = buildFactSummary({ step, locale });
    const isExcluded = step.excluded ? t(locale, "prompt.stepExcludedSuffix") : "";
    lines.push(`### ${t(locale, "prompt.overview.steps")} ${String(stepIndex)}: ${step.stepId}${isExcluded}`);
    lines.push(`- ${t(locale, "prompt.stepKind")}: \`${step.kind}\``);
    lines.push(`- ${t(locale, "prompt.stepSummary")}: ${summary.headline}`);
    lines.push(`- ${t(locale, "prompt.stepStart")}: ${new Date(step.startedAt).toISOString()}`);
    const url = firstRequestUrl(data, step.requestKeys);
    lines.push(
      `- ${t(locale, "prompt.stepUrl")}: ${url ?? t(locale, "prompt.stepNoRequests")}`,
    );
    lines.push(`- ${t(locale, "prompt.stepRequests")}: ${String(step.requestKeys.length)}`);
    if (step.note !== undefined && step.note !== "") {
      lines.push(`- ${t(locale, "prompt.stepNote")}: ${step.note}`);
    }
    lines.push(``);
  }

  // -------------------------------------------------------------------------
  // 6. Blind Spots
  // -------------------------------------------------------------------------
  lines.push(`## 6. ${t(locale, "prompt.blindSpotsTitle")}`);
  lines.push(``);
  lines.push(t(locale, "prompt.blindSpotsIntro"));
  lines.push(``);
  if (data.captureGaps.length === 0) {
    lines.push(`- ${t(locale, "cq.noBlindSpots")}`);
  } else {
    for (const gap of data.captureGaps) {
      const start = new Date(gap.observedStartedAt).toISOString();
      const end =
        gap.observedEndedAt === undefined
          ? t(locale, "prompt.blindSpotOpen")
          : new Date(gap.observedEndedAt).toISOString();
      const reason = t(locale, `format.gapReason.${gap.reason}`);
      lines.push(
        `- ${tpl(locale, "prompt.blindSpotEntry", {
          start,
          end,
          reason,
          capabilities: gap.affectedCapabilities.join("/"),
        })}`,
      );
    }
  }
  lines.push(``);

  return lines.join("\n");
};
