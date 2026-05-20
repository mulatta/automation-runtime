export type RateLimiterState = {
  nextAvailableAtMs: number;
};

export type RateLimitReserveInput = {
  minIntervalMs: number;
  jitterMs?: number;
};

export type RateLimitReservation = {
  delayMs: number;
  intervalMs: number;
  jitterMs: number;
  reservedAt: string;
  nextAvailableAt: string;
};

export type RateLimitReserveDecision = {
  reservation: RateLimitReservation;
  state: RateLimiterState;
};

export function emptyRateLimiterState(nowMs: number): RateLimiterState {
  return { nextAvailableAtMs: nowMs };
}

export function reserveRateLimiterSlot(
  state: RateLimiterState,
  input: RateLimitReserveInput,
  nowMs: number,
  randomUnit = 0,
): RateLimitReserveDecision {
  const jitterMaxMs = Math.max(0, input.jitterMs ?? 0);
  const jitterMs =
    jitterMaxMs === 0
      ? 0
      : Math.min(
          jitterMaxMs,
          Math.floor(clampUnitInterval(randomUnit) * (jitterMaxMs + 1)),
        );
  const reservedAtMs = Math.max(nowMs, state.nextAvailableAtMs);
  const intervalMs = input.minIntervalMs + jitterMs;
  const nextAvailableAtMs = reservedAtMs + intervalMs;

  return {
    reservation: {
      delayMs: Math.max(0, reservedAtMs - nowMs),
      intervalMs,
      jitterMs,
      reservedAt: new Date(reservedAtMs).toISOString(),
      nextAvailableAt: new Date(nextAvailableAtMs).toISOString(),
    },
    state: { nextAvailableAtMs },
  };
}

function clampUnitInterval(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
