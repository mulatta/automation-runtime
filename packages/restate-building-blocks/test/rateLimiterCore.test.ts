import {
  emptyRateLimiterState,
  reserveRateLimiterSlot,
} from "../src/rateLimiterCore";

describe("rateLimiterCore", () => {
  it("reserves first slot without delay", () => {
    const decision = reserveRateLimiterSlot(
      emptyRateLimiterState(1_000),
      { minIntervalMs: 250 },
      1_000,
    );

    expect(decision).toEqual({
      reservation: {
        delayMs: 0,
        intervalMs: 250,
        jitterMs: 0,
        nextAvailableAt: new Date(1_250).toISOString(),
        reservedAt: new Date(1_000).toISOString(),
      },
      state: { nextAvailableAtMs: 1_250 },
    });
  });

  it("delays callers until prior reservations clear", () => {
    const decision = reserveRateLimiterSlot(
      { nextAvailableAtMs: 1_250 },
      { minIntervalMs: 250 },
      1_100,
    );

    expect(decision.reservation.delayMs).toBe(150);
    expect(decision.reservation.reservedAt).toBe(new Date(1_250).toISOString());
    expect(decision.state.nextAvailableAtMs).toBe(1_500);
  });

  it("adds bounded deterministic jitter", () => {
    const decision = reserveRateLimiterSlot(
      emptyRateLimiterState(1_000),
      { minIntervalMs: 250, jitterMs: 4 },
      1_000,
      0.5,
    );

    expect(decision.reservation.jitterMs).toBe(2);
    expect(decision.reservation.intervalMs).toBe(252);
    expect(decision.state.nextAvailableAtMs).toBe(1_252);
  });

  it("does not delay after idle gaps", () => {
    const decision = reserveRateLimiterSlot(
      { nextAvailableAtMs: 1_250 },
      { minIntervalMs: 250 },
      2_000,
    );

    expect(decision.reservation.delayMs).toBe(0);
    expect(decision.reservation.reservedAt).toBe(new Date(2_000).toISOString());
    expect(decision.state.nextAvailableAtMs).toBe(2_250);
  });
});
