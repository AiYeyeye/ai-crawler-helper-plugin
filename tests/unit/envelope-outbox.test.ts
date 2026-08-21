import { describe, expect, it } from "vitest";
import { EnvelopeOutbox } from "../../src/content/envelope-outbox";
import type { EnvelopeAck, EventEnvelope } from "../../src/schemas/event-envelope";
import { gapIdSchema, sessionIdSchema } from "../../src/shared/ids";
import { T0, makeEnvelope } from "../helpers/fixtures";

/**
 * Content-script half of the durable inbox + ACK-after-commit protocol
 * (design 4.1): unacknowledged envelopes are retained and replayed
 * idempotently; non-retryable rejections are dropped by contract (the
 * interval is covered by a CaptureGap, never backfilled).
 */

const sessionId = sessionIdSchema.parse("ses_outbox_test");

const makeGapCloseEnvelope = (n: number): EventEnvelope =>
  makeEnvelope(sessionId, {
    kind: "capture_gap_close",
    gapId: gapIdSchema.parse(`gap_${String(n)}`),
    observedEndedAt: T0,
  });

const okResponse = (acks: EnvelopeAck[]): unknown => ({
  ok: true,
  value: { acks },
});

describe("EnvelopeOutbox (content-script ACK / replay protocol)", () => {
  it("removes envelopes acknowledged as committed or duplicate", async () => {
    const a = makeGapCloseEnvelope(1);
    const b = makeGapCloseEnvelope(2);
    const outbox = new EnvelopeOutbox(() =>
      Promise.resolve(
        okResponse([
          { status: "committed", eventId: a.eventId, committedBytes: 10 },
          { status: "duplicate", eventId: b.eventId },
        ]),
      ),
    );
    outbox.enqueue(a);
    outbox.enqueue(b);
    const acks = await outbox.flush();
    expect(acks).toHaveLength(2);
    expect(outbox.pendingCount()).toBe(0);
  });

  it("retains every envelope when the worker is unreachable (restart window)", async () => {
    const outbox = new EnvelopeOutbox(() => Promise.reject(new Error("worker gone")));
    outbox.enqueue(makeGapCloseEnvelope(1));
    outbox.enqueue(makeGapCloseEnvelope(2));
    const acks = await outbox.flush();
    expect(acks).toHaveLength(0);
    expect(outbox.pendingCount()).toBe(2); // replayed on the next flush
  });

  it("retains envelopes when the response fails protocol validation", async () => {
    const outbox = new EnvelopeOutbox(() => Promise.resolve({ totally: "unexpected" }));
    outbox.enqueue(makeGapCloseEnvelope(1));
    await outbox.flush();
    expect(outbox.pendingCount()).toBe(1);
  });

  it("keeps retryable rejections pending and drops non-retryable ones", async () => {
    const retryable = makeGapCloseEnvelope(1);
    const fatal = makeGapCloseEnvelope(2);
    const sentBatches: { envelopes: EventEnvelope[] }[] = [];
    let firstCall = true;
    const outbox = new EnvelopeOutbox((message) => {
      sentBatches.push(message as { envelopes: EventEnvelope[] });
      if (firstCall) {
        firstCall = false;
        return Promise.resolve(
          okResponse([
            {
              status: "rejected",
              eventId: retryable.eventId,
              errorCode: "PERSISTENCE_TRANSACTION_FAILED",
              retryable: true,
            },
            {
              status: "rejected",
              eventId: fatal.eventId,
              errorCode: "CAPACITY_HEADROOM_EXHAUSTED",
              retryable: false,
            },
          ]),
        );
      }
      return Promise.resolve(okResponse([]));
    });
    outbox.enqueue(retryable);
    outbox.enqueue(fatal);
    await outbox.flush();
    expect(outbox.pendingCount()).toBe(1); // only the retryable one survives
    // The next flush replays exactly the retained envelope (same eventId).
    await outbox.flush();
    expect(sentBatches[1]?.envelopes.map((e) => e.eventId)).toEqual([retryable.eventId]);
  });

  it("replays the identical envelope on the next flush after a missed ACK", async () => {
    const envelope = makeGapCloseEnvelope(1);
    const sent: unknown[] = [];
    let failFirst = true;
    const outbox = new EnvelopeOutbox((message) => {
      sent.push(message);
      if (failFirst) {
        failFirst = false;
        return Promise.reject(new Error("restart"));
      }
      return Promise.resolve(
        okResponse([
          { status: "duplicate", eventId: envelope.eventId },
        ]),
      );
    });
    outbox.enqueue(envelope);
    await outbox.flush(); // lost
    const acks = await outbox.flush(); // idempotent replay, same eventId
    expect(acks).toEqual([{ status: "duplicate", eventId: envelope.eventId }]);
    expect(outbox.pendingCount()).toBe(0);
    const first = sent[0] as { envelopes: EventEnvelope[] };
    const second = sent[1] as { envelopes: EventEnvelope[] };
    expect(second.envelopes[0]?.eventId).toBe(first.envelopes[0]?.eventId);
  });

  it("allocates monotonically increasing source sequence numbers", () => {
    const outbox = new EnvelopeOutbox(() => Promise.resolve(okResponse([])));
    expect(outbox.allocateSeq()).toBe(0);
    expect(outbox.allocateSeq()).toBe(1);
    expect(outbox.allocateSeq()).toBe(2);
  });
});
