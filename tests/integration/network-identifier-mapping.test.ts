import { describe, expect, it } from "vitest";
import { NetworkStateRepository } from "../../src/persistence/network-state-repository";
import {
  attachEpochSchema,
  cdpFrameIdSchema,
  cdpLoaderIdSchema,
  cdpSessionIdSchema,
  captureEpochIdSchema,
  extDocumentIdSchema,
  extFrameIdSchema,
  extTabIdSchema,
} from "../../src/shared/ids";
import { createHarness, createRecordingSession, T0 } from "../helpers/fixtures";

interface MappingRepositoryContract {
  upsertIdentifierMapping(input: unknown): Promise<unknown>;
  getIdentifierMapping(input: unknown): Promise<unknown>;
}

describe("durable network identifier mappings", () => {
  it("round-trips an explicit mapping by its complete CDP key across a worker restart", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);
    const repository = new NetworkStateRepository(harness.db);
    const contract = repository as unknown as Partial<MappingRepositoryContract>;

    expect(typeof contract.upsertIdentifierMapping).toBe("function");
    expect(typeof contract.getIdentifierMapping).toBe("function");
    if (
      contract.upsertIdentifierMapping === undefined ||
      contract.getIdentifierMapping === undefined
    ) {
      return;
    }

    const key = {
      sessionId: session.sessionId,
      tabId: extTabIdSchema.parse(1),
      childSessionId: cdpSessionIdSchema.parse("child-oopif"),
      attachEpoch: attachEpochSchema.parse(3),
      frameId: cdpFrameIdSchema.parse("CDP-FRAME-3"),
      loaderId: cdpLoaderIdSchema.parse("CDP-LOADER-3"),
    };
    await contract.upsertIdentifierMapping({
      ...key,
      captureEpochId: captureEpochIdSchema.parse("cep-mapping"),
      mapping: {
        state: "confirmed",
        ext: {
          tabId: extTabIdSchema.parse(1),
          frameId: extFrameIdSchema.parse(7),
          documentId: extDocumentIdSchema.parse("doc-oopif"),
        },
        cdp: {
          sessionId: key.childSessionId,
          frameId: key.frameId,
          loaderId: key.loaderId,
        },
        evidence: "browser_verified_mapping:nav-42",
        mappedAt: T0,
      },
      recordedAt: T0,
    });

    const restarted = await harness.restart();
    const restoredRepository = new NetworkStateRepository(restarted.db) as unknown as
      MappingRepositoryContract;
    await expect(restoredRepository.getIdentifierMapping(key)).resolves.toMatchObject({
      mapping: {
        state: "confirmed",
        ext: { frameId: 7, documentId: "doc-oopif" },
        cdp: { frameId: "CDP-FRAME-3", loaderId: "CDP-LOADER-3" },
        evidence: "browser_verified_mapping:nav-42",
      },
    });
  });
});
