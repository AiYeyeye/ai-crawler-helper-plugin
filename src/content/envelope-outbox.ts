import { PROTOCOL_VERSION } from "../shared/messages";
import type { EventEnvelope, EnvelopeAck } from "../schemas/event-envelope";
import type { EventId } from "../shared/ids";
import { factsSubmitResponseSchema, runtimeResponseSchema } from "../shared/messages";

/**
 * EnvelopeOutbox (design 4.1): the content-script side of the durable
 * inbox + ACK-after-commit protocol.
 *
 * Envelopes are retained in this document's memory until the service worker
 * acknowledges them as committed/duplicate, and are replayed idempotently
 * (same eventId) when an ACK is missing — e.g. across a service-worker
 * restart within this document's lifetime. `retryable: false` rejections are
 * dropped by contract (the interval is covered by a CaptureGap; facts are
 * never backfilled).
 */
interface AcknowledgeableEnvelope {
  readonly eventId: EventId;
}

type SubmissionRoute = "facts/submit" | "observations/submit";
type NonRetryableRejectionHandler<TEnvelope> = (
  ack: Extract<EnvelopeAck, { status: "rejected" }>,
  envelope: TEnvelope,
) => void | Promise<void>;

export class EnvelopeOutbox<
  TEnvelope extends AcknowledgeableEnvelope = EventEnvelope,
> {
  private readonly pending = new Map<string, TEnvelope>();
  private nextSeq = 0;
  private activeFlush: Promise<EnvelopeAck[]> | null = null;

  constructor(
    private readonly send: (message: unknown) => Promise<unknown> = (message) =>
      chrome.runtime.sendMessage(message),
    private readonly route: SubmissionRoute = "facts/submit",
    private readonly onNonRetryableRejection?: NonRetryableRejectionHandler<TEnvelope>,
  ) {}

  allocateSeq(): number {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    return seq;
  }

  enqueue(envelope: TEnvelope): void {
    this.pending.set(envelope.eventId, envelope);
  }

  pendingCount(): number {
    return this.pending.size;
  }

  discardWhere(predicate: (envelope: TEnvelope) => boolean): number {
    let discarded = 0;
    for (const [eventId, envelope] of this.pending) {
      if (predicate(envelope)) {
        this.pending.delete(eventId);
        discarded += 1;
      }
    }
    return discarded;
  }

  /** Submit all pending envelopes; resolve per-event ACKs; keep unacked. */
  async flush(): Promise<EnvelopeAck[]> {
    if (this.activeFlush !== null) {
      await this.activeFlush;
      return this.pending.size === 0 ? [] : this.flush();
    }
    if (this.pending.size === 0) {
      return [];
    }
    this.activeFlush = this.flushPending();
    try {
      return await this.activeFlush;
    } finally {
      this.activeFlush = null;
    }
  }

  private async flushPending(): Promise<EnvelopeAck[]> {
    const envelopes = [...this.pending.values()];
    try {
      const message =
        this.route === "facts/submit"
          ? { protocolVersion: PROTOCOL_VERSION, type: this.route, envelopes }
          : { protocolVersion: PROTOCOL_VERSION, type: this.route, observations: envelopes };
      const rawResponse = await this.send(message);
      const response = runtimeResponseSchema.safeParse(rawResponse);
      if (!response.success || !response.data.ok) {
        return []; // no ACK — everything stays pending for replay
      }
      const payload = factsSubmitResponseSchema.safeParse(response.data.value);
      if (!payload.success) {
        return [];
      }
      for (const ack of payload.data.acks) {
        const envelope = this.pending.get(ack.eventId);
        if (ack.status === "committed" || ack.status === "duplicate") {
          this.pending.delete(ack.eventId);
        } else if (!ack.retryable) {
          this.pending.delete(ack.eventId);
          if (envelope !== undefined) {
            await this.onNonRetryableRejection?.(ack, envelope);
          }
        }
      }
      return payload.data.acks;
    } catch {
      // Worker unreachable (restart window): retain everything, replay later.
      return [];
    }
  }
}
