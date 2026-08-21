import { buildFactSummary } from "../core/fact-summary";
import type { Locale } from "../shared/i18n";
import { collectSessionExportData, type SessionExportData } from "../persistence/export-readback";
import { type ExportJobRecord, type ExportSnapshotRecord } from "../schemas/export";
import { isSealedStep } from "../schemas/step";
import { businessError } from "../shared/errors";
import { domRecordIdSchema, type SessionId } from "../shared/ids";
import { buildContextIndex } from "./context-index-builder";
import { buildHar } from "./har-builder";
import { buildWorkflowPrompt } from "./workflow-prompt-builder";
import { ZipWriter, type ZipWriterTarget } from "./zip-writer";

export const SINGLE_JSON_BYTE_LIMIT = 10 * 1024 * 1024; // 10 MiB

export interface ExportResult {
  format: "zip" | "single_json";
  totalBytes: number;
  entryCount: number;
  singleJsonContent?: string;
}

/**
 * Main Archive Exporter (design 13).
 *
 * Reads session data via `collectSessionExportData` (which enforces Zod schema
 * validation on every record). Generates streaming ZIP or single JSON exports.
 * Any schema invalidity fails closed with `EXPORT_VALIDATION_FAILED`.
 */
export class ArchiveExporter {
  private readonly db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.db = db;
  }

  /**
   * Run export for session into the given target (WritableStream / ZipWriterTarget).
   */
  async exportArchive(
    sessionId: SessionId,
    snapshot: ExportSnapshotRecord,
    job: ExportJobRecord,
    target: ZipWriterTarget,
    locale: Locale,
  ): Promise<ExportResult> {
    const data = await collectSessionExportData(this.db, sessionId);
    const contextIndex = await buildContextIndex(this.db, sessionId);

    if (job.format === "single_json") {
      return this.exportSingleJson(data, contextIndex, target, locale);
    }

    return this.exportZipArchive(data, contextIndex, snapshot, target, locale);
  }

  private async exportSingleJson(
    data: SessionExportData,
    contextIndex: unknown,
    target: ZipWriterTarget,
    locale: Locale,
  ): Promise<ExportResult> {
    const payload = {
      manifest: {
        generator: "ai-crawler-helper-plugin",
        version: 1,
        sessionId: data.session.sessionId,
        exportedAt: Date.now(),
      },
      session: data.session,
      control: data.control,
      contextIndex,
      steps: data.steps,
      navigations: data.navigations,
      requests: data.requests,
      storageSnapshots: data.storageSnapshots,
      storageDiffs: data.storageDiffs,
      captureGaps: data.captureGaps,
      workflowPrompt: buildWorkflowPrompt(data, locale),
      har: buildHar(data),
    };

    const jsonStr = JSON.stringify(payload, null, 2);
    const bytes = new TextEncoder().encode(jsonStr);

    if (bytes.length > SINGLE_JSON_BYTE_LIMIT) {
      const err = businessError(
        "EXPORT_VALIDATION_FAILED",
        `single JSON size (${String(bytes.length)} bytes) exceeds limit (${String(SINGLE_JSON_BYTE_LIMIT)} bytes)`,
      );
      throw new Error(err.message);
    }

    await target.write(bytes);

    return {
      format: "single_json",
      totalBytes: bytes.length,
      entryCount: 1,
      singleJsonContent: jsonStr,
    };
  }

  private async exportZipArchive(
    data: SessionExportData,
    contextIndex: unknown,
    snapshot: ExportSnapshotRecord,
    target: ZipWriterTarget,
    locale: Locale,
  ): Promise<ExportResult> {
    const zip = new ZipWriter(target);
    let entryCount = 0;

    // 1. manifest.json
    const manifest = {
      generator: "ai-crawler-helper-plugin",
      version: 1,
      sessionId: data.session.sessionId,
      snapshot,
      exportedAt: Date.now(),
    };
    await zip.addFile("manifest.json", JSON.stringify(manifest, null, 2));
    entryCount++;

    // 2. context-index.json
    await zip.addFile("context-index.json", JSON.stringify(contextIndex, null, 2));
    entryCount++;

    // 3. capture-gaps.json
    await zip.addFile("capture-gaps.json", JSON.stringify(data.captureGaps, null, 2));
    entryCount++;

    // 4. workflow-prompt.md
    const promptMd = buildWorkflowPrompt(data, locale);
    await zip.addFile("workflow-prompt.md", promptMd);
    entryCount++;

    // 5. session.har (Standard HTTP Archive 1.2 for external tools and agents)
    const harLog = buildHar(data);
    await zip.addFile("session.har", JSON.stringify(harLog, null, 2));
    entryCount++;

    // 6. storage/
    const initialStorage = data.storageSnapshots.find((s) => s.role === "initial");
    const finalStorage = data.storageSnapshots.find((s) => s.role === "final");
    await zip.addFile("storage/initial.json", JSON.stringify(initialStorage ?? null, null, 2));
    await zip.addFile("storage/final.json", JSON.stringify(finalStorage ?? null, null, 2));
    await zip.addFile("storage/diffs.json", JSON.stringify(data.storageDiffs, null, 2));
    entryCount += 3;

    // Index mappings for domRecords, navigations, requests, responseBodies
    const domMap = new Map(data.domRecords.map((d) => [d.domRecordId, d]));
    const navMap = new Map(data.navigations.map((n) => [n.navigationRecordId, n]));
    const reqMap = new Map(data.requests.map((r) => [r.requestKey, r]));
    const bodyMap = new Map(data.responseBodies.map((b) => [b.bodyRef, b]));

    // Build timeline items
    const timelineItems = [];

    for (let i = 0; i < data.steps.length; i++) {
      const step = data.steps[i];
      if (step === undefined || !isSealedStep(step)) {
        continue;
      }

      const isExcluded = step.excluded;
      const dirPrefix = isExcluded ? "excluded-steps" : "steps";
      const paddedIndex = String(i + 1).padStart(4, "0");
      const stepDir = `${dirPrefix}/step-${paddedIndex}`;

      const factSummary = buildFactSummary({ step, locale });

      timelineItems.push({
        index: i + 1,
        stepId: step.stepId,
        kind: step.kind,
        type: step.type,
        factSummary,
        excluded: isExcluded,
        path: `${stepDir}/step.json`,
      });

      // Write step.json
      await zip.addFile(`${stepDir}/step.json`, JSON.stringify(step, null, 2));
      entryCount++;

      // Write dom-before.json if user_action
      if (step.kind === "user_action") {
        await zip.addFile(
          `${stepDir}/dom-before.json`,
          JSON.stringify(step.domBefore, null, 2),
        );
        entryCount++;
      }

      // Write dom-after.json if present
      if (step.domAfter.captured) {
        await zip.addFile(
          `${stepDir}/dom-after.json`,
          JSON.stringify(step.domAfter, null, 2),
        );
        entryCount++;
      }

      // Write DOM records linked to this step
      for (let dIdx = 0; dIdx < step.domRecordIds.length; dIdx++) {
        const domId = step.domRecordIds[dIdx];
        if (domId !== undefined) {
          const domRec = domMap.get(domRecordIdSchema.parse(domId));
          if (domRec !== undefined) {
            await zip.addFile(
              `${stepDir}/dom-records/dom-${String(dIdx + 1).padStart(4, "0")}.json`,
              JSON.stringify(domRec, null, 2),
            );
            entryCount++;
          }
        }
      }

      // Write navigation.json if system_navigation
      if (step.kind === "system_navigation") {
        const nav = navMap.get(step.navigation.navigationRecordId);
        await zip.addFile(
          `${stepDir}/navigation.json`,
          JSON.stringify(nav ?? null, null, 2),
        );
        entryCount++;
      }

      // Write step requests
      for (let j = 0; j < step.requestKeys.length; j++) {
        const reqKey = step.requestKeys[j];
        if (reqKey !== undefined) {
          const req = reqMap.get(reqKey);
          if (req !== undefined) {
            const reqPadded = String(j + 1).padStart(4, "0");
            await zip.addFile(
              `${stepDir}/requests/req-${reqPadded}.json`,
              JSON.stringify(req, null, 2),
            );
            entryCount++;

            const resBody = req.responseBody;
            if (resBody !== undefined && resBody.kind === "captured") {
              const bodyRef = resBody.bodyRef;
              const bodyRecord = bodyMap.get(bodyRef);
              if (bodyRecord !== undefined) {
                await zip.addFile(
                  `${stepDir}/requests/req-${reqPadded}-body.txt`,
                  bodyRecord.text,
                );
                entryCount++;
              }
            }
          }
        }
      }
    }

    // Write timeline.json
    await zip.addFile("timeline.json", JSON.stringify(timelineItems, null, 2));
    entryCount++;

    await zip.close();

    return {
      format: "zip",
      totalBytes: 0,
      entryCount,
    };
  }
}
