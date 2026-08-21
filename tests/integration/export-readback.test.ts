import { describe, expect, it } from "vitest";
import { STORES, runAtomicWrite } from "../../src/persistence/database";
import {
  ExportValidationError,
  collectSessionExportData,
} from "../../src/persistence/export-readback";
import { createHarness, createRecordingSession } from "../helpers/fixtures";

describe("validated export read-back", () => {
  it("maps invalid session metadata to EXPORT_VALIDATION_FAILED", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);
    await runAtomicWrite(harness.db, [STORES.sessions], (txn) => {
      txn.objectStore(STORES.sessions).put({ ...session, lifecycle: "corrupted" });
      return Promise.resolve();
    });

    await expect(collectSessionExportData(harness.db, session.sessionId)).rejects.toMatchObject({
      name: ExportValidationError.name,
      businessError: { code: "EXPORT_VALIDATION_FAILED" },
    });
  });
});
