import { describe, expect, it } from "vitest";
import { getAllRecords } from "../../src/persistence/database";
import { collectSessionExportData } from "../../src/persistence/export-readback";
import { SCHEMA_VERSION } from "../../src/schemas/common";
import { networkStreamMessageRecordSchema } from "../../src/schemas/network";
import { eventIdSchema, stepIdSchema } from "../../src/shared/ids";
import { createHarness, createRecordingSession, makeEnvelope, T0 } from "../helpers/fixtures";

describe("network stream persistence", () => {
  it("commits WebSocket metadata atomically and includes it in validated export readback", async () => {
    const harness = await createHarness();
    const session = await createRecordingSession(harness);
    const messageId = eventIdSchema.parse("evt-websocket-binary");
    const record = networkStreamMessageRecordSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      messageId,
      requestKey: "1|-|0|REQ-STREAM|0",
      sessionId: session.sessionId,
      startedInStepId: stepIdSchema.parse("stp-stream-start"),
      observedDuringStepId: stepIdSchema.parse("stp-stream-observed"),
      observedAt: T0 + 20,
      kind: "websocket",
      direction: "received",
      payload: {
        kind: "binary_metadata_only",
        opcode: 2,
        byteLength: 3,
      },
    });

    const ack = await harness.ingestor.ingest(
      makeEnvelope(
        session.sessionId,
        { kind: "network_stream_message", record },
        { eventId: messageId },
      ),
    );

    expect(ack.status).toBe("committed");
    const txn = harness.db.transaction(["networkStreamMessages"], "readonly");
    const stored = await getAllRecords(txn.objectStore("networkStreamMessages"));
    expect(stored.map((value) => networkStreamMessageRecordSchema.parse(value))).toEqual([record]);

    const exported = await collectSessionExportData(harness.db, session.sessionId);
    expect(exported.networkStreamMessages).toEqual([record]);
    expect(JSON.stringify(exported.networkStreamMessages)).not.toContain("AAEC");
  });
});
