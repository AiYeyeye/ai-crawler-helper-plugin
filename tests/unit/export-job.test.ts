import { describe, expect, it } from "vitest";
import {
  createExportJob,
  createExportSnapshot,
  getExportJob,
  getExportSnapshot,
  updateExportJob,
} from "../../src/persistence/export-job-repository";
import { createHarness, createRecordingSession } from "../helpers/fixtures";
import { SCHEMA_VERSION } from "../../src/schemas/common";

describe("ExportJob & ExportSnapshot repository", () => {
  it("creates and retrieves frozen ExportSnapshot and ExportJob", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);

    const snapshot = await createExportSnapshot(harness.db, session.sessionId);
    expect(snapshot.schemaVersion).toBe(SCHEMA_VERSION);
    expect(snapshot.sessionId).toBe(session.sessionId);
    expect(snapshot.snapshotId).toBeDefined();

    const fetchedSnapshot = await getExportSnapshot(harness.db, snapshot.snapshotId);
    expect(fetchedSnapshot).toEqual(snapshot);

    const job = await createExportJob(
      harness.db,
      session.sessionId,
      snapshot.snapshotId,
      "zip",
      "opfs_downloads_fallback",
    );

    expect(job.state).toBe("queued");
    expect(job.schemaVersion).toBe(SCHEMA_VERSION);

    const updatedJob = await updateExportJob(harness.db, job.jobId, {
      state: "writing",
      completedEntryCount: 5,
    });

    expect(updatedJob.state).toBe("writing");
    expect(updatedJob.completedEntryCount).toBe(5);

    const fetchedJob = await getExportJob(harness.db, job.jobId);
    expect(fetchedJob).toEqual(updatedJob);
  });
});
