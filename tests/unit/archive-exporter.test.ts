import { describe, expect, it } from "vitest";
import { ArchiveExporter } from "../../src/export/archive-exporter";
import {
  createExportJob,
  createExportSnapshot,
} from "../../src/persistence/export-job-repository";
import { createHarness, createRecordingSession } from "../helpers/fixtures";

describe("ArchiveExporter unit tests", () => {
  it("exports session as ZIP archive with timeline, manifest, gaps and step dirs", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);

    const snapshot = await createExportSnapshot(harness.db, session.sessionId);
    const job = await createExportJob(
      harness.db,
      session.sessionId,
      snapshot.snapshotId,
      "zip",
      "opfs_downloads_fallback",
    );

    const chunks: Uint8Array[] = [];
    const exporter = new ArchiveExporter(harness.db);

    const result = await exporter.exportArchive(
      session.sessionId,
      snapshot,
      job,
      {
        write: (chunk) => {
          chunks.push(chunk);
          return Promise.resolve();
        },
      },
      "zh",
    );

    expect(result.format).toBe("zip");
    expect(result.entryCount).toBeGreaterThan(3);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("exports session as single JSON when requested", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);

    const snapshot = await createExportSnapshot(harness.db, session.sessionId);
    const job = await createExportJob(
      harness.db,
      session.sessionId,
      snapshot.snapshotId,
      "single_json",
      "opfs_downloads_fallback",
    );

    const chunks: Uint8Array[] = [];
    const exporter = new ArchiveExporter(harness.db);

    const result = await exporter.exportArchive(
      session.sessionId,
      snapshot,
      job,
      {
        write: (chunk) => {
          chunks.push(chunk);
          return Promise.resolve();
        },
      },
      "zh",
    );

    expect(result.format).toBe("single_json");
    expect(result.singleJsonContent).toBeDefined();
    if (result.singleJsonContent !== undefined) {
      const parsed = JSON.parse(result.singleJsonContent) as {
        session: { sessionId: string };
        har: { log: { version: string; entries: unknown[] } };
      };
      expect(parsed.session.sessionId).toBe(session.sessionId);
      expect(parsed.har).toBeDefined();
      expect(parsed.har.log.version).toBe("1.2");
    }
  });
});
