import { describe, expect, it } from "vitest";
import { CapacityGuard } from "../../src/core/capacity-guard";
import type { CapacityGuardConfig } from "../../src/core/config";

const config: CapacityGuardConfig = {
  estimateErrorMarginBytes: 1000,
  durableStopReserveBytes: 500,
  maxTransactionBytes: 10_000,
  reestimateIntervalBytes: 100_000,
};

describe("CapacityGuard admission rule", () => {
  it("admits when headroom exceeds required headroom", async () => {
    const guard = new CapacityGuard(
      () => Promise.resolve({ quota: 100_000, usage: 10_000 }),
      config,
    );
    const decision = await guard.admit(2000);
    expect(decision.admitted).toBe(true);
    if (decision.admitted) {
      expect(decision.estimatedHeadroom).toBe(90_000);
      expect(decision.requiredHeadroom).toBe(2000 + 500 + 1000);
    }
  });

  it("rejects on insufficient headroom (quota - usage <= required)", async () => {
    const guard = new CapacityGuard(
      () => Promise.resolve({ quota: 100_000, usage: 97_000 }),
      config,
    );
    const decision = await guard.admit(2000);
    expect(decision).toMatchObject({ admitted: false, reason: "insufficient_headroom" });
  });

  it("rejects when estimate() throws — never guesses around a failed probe", async () => {
    const guard = new CapacityGuard(() => Promise.reject(new Error("boom")), config);
    const decision = await guard.admit(100);
    expect(decision).toMatchObject({ admitted: false, reason: "estimate_unavailable" });
  });

  it("rejects invalid estimate values (NaN / negative)", async () => {
    const guard = new CapacityGuard(
      () => Promise.resolve({ quota: Number.NaN, usage: 0 }),
      config,
    );
    expect(await guard.admit(100)).toMatchObject({
      admitted: false,
      reason: "estimate_unavailable",
    });
    const guard2 = new CapacityGuard(() => Promise.resolve({ quota: -1, usage: 0 }), config);
    expect(await guard2.admit(100)).toMatchObject({
      admitted: false,
      reason: "estimate_unavailable",
    });
  });

  it("rejects a single transaction larger than the configured maximum", async () => {
    const guard = new CapacityGuard(
      () => Promise.resolve({ quota: 1e12, usage: 0 }),
      config,
    );
    const decision = await guard.admit(config.maxTransactionBytes + 1);
    expect(decision).toMatchObject({ admitted: false, reason: "transaction_too_large" });
  });

  it("rejects after a reported write failure until explicitly cleared", async () => {
    const guard = new CapacityGuard(() => Promise.resolve({ quota: 1e9, usage: 0 }), config);
    guard.reportWriteFailure("quota");
    expect(await guard.admit(10)).toMatchObject({
      admitted: false,
      reason: "previous_write_failed",
    });
    guard.clearWriteFailure();
    expect((await guard.admit(10)).admitted).toBe(true);
  });

  it("accounts committed bytes against cached headroom between estimates", async () => {
    let calls = 0;
    const guard = new CapacityGuard(() => {
      calls += 1;
      return Promise.resolve({ quota: 10_000, usage: 0 });
    }, config);
    const first = await guard.admit(100);
    expect(first.admitted).toBe(true);
    guard.reportCommittedBytes(8_000);
    // 10_000 - 8_000 = 2_000 headroom <= 100 + 1500 required -> reject
    const second = await guard.admit(1000);
    expect(second).toMatchObject({ admitted: false, reason: "insufficient_headroom" });
    expect(calls).toBe(1); // still within the re-estimate interval
  });

  it("re-estimates after the configured committed-bytes interval", async () => {
    let calls = 0;
    const guard = new CapacityGuard(() => {
      calls += 1;
      return Promise.resolve({ quota: 1e9, usage: 0 });
    }, config);
    await guard.admit(100);
    guard.reportCommittedBytes(config.reestimateIntervalBytes + 1);
    await guard.admit(100);
    expect(calls).toBe(2);
  });
});
