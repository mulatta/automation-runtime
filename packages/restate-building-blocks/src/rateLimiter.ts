import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";

import {
  emptyRateLimiterState,
  RateLimitReservation,
  RateLimiterState,
  reserveRateLimiterSlot,
} from "./rateLimiterCore";

export const RateLimitReserveRequest = z
  .object({
    minIntervalMs: z
      .number()
      .int()
      .nonnegative()
      .max(24 * 60 * 60 * 1000),
    jitterMs: z
      .number()
      .int()
      .nonnegative()
      .max(24 * 60 * 60 * 1000)
      .default(0),
  })
  .strict();
export type RateLimitReserveRequest = z.infer<typeof RateLimitReserveRequest>;

export type RateLimiterOptions = {
  name?: string;
};

export type WithRateLimitOptions = {
  jitterMs?: number;
  minIntervalMs: number;
  rateLimiterService?: string;
  resourceKey: string;
  sleepName?: string;
};

const DEFAULT_RATE_LIMITER_SERVICE = "DurableRateLimiter";
const STATE_KEY = "state";

export function createRateLimiter(options: RateLimiterOptions = {}) {
  return restate.object({
    name: options.name ?? DEFAULT_RATE_LIMITER_SERVICE,
    handlers: {
      reserve: async (
        ctx: restate.ObjectContext,
        input: unknown,
      ): Promise<RateLimitReservation> => {
        const request = RateLimitReserveRequest.parse(input ?? {});
        const now = await ctx.date.now();
        const decision = reserveRateLimiterSlot(
          (await ctx.get<RateLimiterState>(STATE_KEY)) ??
            emptyRateLimiterState(now),
          request,
          now,
          ctx.rand.random(),
        );
        ctx.set(STATE_KEY, decision.state);
        return decision.reservation;
      },
    },
  });
}

export const rateLimiter = createRateLimiter();
export type RateLimiter = ReturnType<typeof createRateLimiter>;

export async function reserveRateLimit(
  ctx: restate.Context,
  options: WithRateLimitOptions,
): Promise<RateLimitReservation> {
  return await ctx.genericCall<RateLimitReserveRequest, RateLimitReservation>({
    service: options.rateLimiterService ?? DEFAULT_RATE_LIMITER_SERVICE,
    method: "reserve",
    key: options.resourceKey,
    parameter: {
      jitterMs: options.jitterMs ?? 0,
      minIntervalMs: options.minIntervalMs,
    },
    inputSerde: restate.serde.json,
    outputSerde: restate.serde.json,
  });
}

export async function waitForRateLimit(
  ctx: restate.Context,
  options: WithRateLimitOptions,
): Promise<RateLimitReservation> {
  const reservation = await reserveRateLimit(ctx, options);
  if (reservation.delayMs > 0) {
    await ctx.sleep(reservation.delayMs, options.sleepName ?? "rate-limit");
  }
  return reservation;
}
