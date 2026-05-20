import * as restate from "@restatedev/restate-sdk";
import { z } from "zod";

import {
  acquireLeaseQueueItem,
  dropLeaseQueueItem,
  emptyLeaseQueueState,
  LeaseQueueGrant,
  LeaseQueueLease,
  LeaseQueueState,
  leaseQueueSize,
  releaseLeaseQueueItem,
} from "./leaseQueueCore";

const AwakeableId = z.string().trim().min(1).max(512);
const RequesterId = z.string().trim().min(1).max(512);
const LeaseId = z.string().trim().min(1).max(512);

export const LeaseQueueAcquireRequest = z
  .object({
    awakeableId: AwakeableId,
    leaseTtlMs: z.number().int().positive().optional(),
    maxInFlight: z.number().int().positive().max(1000).optional(),
    priority: z.number().int().default(0),
    requesterId: RequesterId,
  })
  .strict();
export type LeaseQueueAcquireRequest = z.infer<typeof LeaseQueueAcquireRequest>;

export const LeaseQueueReleaseRequest = z.object({ leaseId: LeaseId }).strict();
export type LeaseQueueReleaseRequest = z.infer<typeof LeaseQueueReleaseRequest>;

export const LeaseQueueDropRequest = z
  .object({ awakeableId: AwakeableId })
  .strict();
export type LeaseQueueDropRequest = z.infer<typeof LeaseQueueDropRequest>;

export type LeaseQueueAcquireResult = {
  granted: number;
  inFlight: number;
  pending: number;
};

export type LeaseQueueReleaseResult = LeaseQueueAcquireResult & {
  released: boolean;
};

export type LeaseQueueDropResult = {
  dropped: boolean;
  inFlight: number;
  pending: number;
};

export type LeaseQueueStatus = {
  inFlight: number;
  maxInFlight: number;
  pending: number;
};

export type LeaseQueueOptions = {
  name?: string;
};

const DEFAULT_LEASE_QUEUE_SERVICE = "DurableLeaseQueue";
const STATE_KEY = "state";

export function createLeaseQueue(options: LeaseQueueOptions = {}) {
  return restate.object({
    name: options.name ?? DEFAULT_LEASE_QUEUE_SERVICE,
    handlers: {
      acquire: async (
        ctx: restate.ObjectContext,
        input: unknown,
      ): Promise<LeaseQueueAcquireResult> => {
        const request = LeaseQueueAcquireRequest.parse(input);
        const state = await getState(ctx);
        const decision = acquireLeaseQueueItem(
          state,
          ctx.key,
          request,
          ctx.rand.uuidv4(),
          await ctx.date.now(),
        );
        resolveGrantedLeases(ctx, decision.granted);
        ctx.set(STATE_KEY, decision.state);
        return {
          granted: decision.granted.length,
          ...leaseQueueSize(decision.state),
        };
      },

      release: async (
        ctx: restate.ObjectContext,
        input: unknown,
      ): Promise<LeaseQueueReleaseResult> => {
        const request = LeaseQueueReleaseRequest.parse(input);
        const state = await getState(ctx);
        const decision = releaseLeaseQueueItem(
          state,
          ctx.key,
          request,
          await ctx.date.now(),
        );
        resolveGrantedLeases(ctx, decision.granted);
        ctx.set(STATE_KEY, decision.state);
        return {
          granted: decision.granted.length,
          released: decision.released,
          ...leaseQueueSize(decision.state),
        };
      },

      drop: async (
        ctx: restate.ObjectContext,
        input: unknown,
      ): Promise<LeaseQueueDropResult> => {
        const request = LeaseQueueDropRequest.parse(input);
        const state = await getState(ctx);
        const decision = dropLeaseQueueItem(state, request);
        ctx.set(STATE_KEY, decision.state);
        return { dropped: decision.dropped, ...leaseQueueSize(decision.state) };
      },

      status: restate.handlers.object.shared(
        async (ctx: restate.ObjectSharedContext): Promise<LeaseQueueStatus> => {
          const state = await getState(ctx);
          return { maxInFlight: state.maxInFlight, ...leaseQueueSize(state) };
        },
      ),
    },
  });
}

export const leaseQueue = createLeaseQueue();
export type LeaseQueue = ReturnType<typeof createLeaseQueue>;

export type WithLeaseOptions = {
  leaseQueueService?: string;
  leaseTtlMs?: number;
  maxInFlight?: number;
  priority?: number;
  requesterId: string;
  resourceKey: string;
};

export async function withLease<T>(
  ctx: restate.Context,
  options: WithLeaseOptions,
  run: (lease: LeaseQueueLease) => Promise<T>,
): Promise<T> {
  const awakeable = ctx.awakeable<LeaseQueueLease>();
  const service = options.leaseQueueService ?? DEFAULT_LEASE_QUEUE_SERVICE;
  ctx.genericSend<LeaseQueueAcquireRequest>({
    service,
    method: "acquire",
    key: options.resourceKey,
    parameter: {
      awakeableId: awakeable.id,
      leaseTtlMs: options.leaseTtlMs,
      maxInFlight: options.maxInFlight,
      priority: options.priority ?? 0,
      requesterId: options.requesterId,
    },
    inputSerde: restate.serde.json,
  });

  let lease: LeaseQueueLease;
  try {
    lease = await awakeable.promise;
  } catch (error) {
    ctx.genericSend<LeaseQueueDropRequest>({
      service,
      method: "drop",
      key: options.resourceKey,
      parameter: { awakeableId: awakeable.id },
      inputSerde: restate.serde.json,
    });
    throw error;
  }

  try {
    return await run(lease);
  } finally {
    ctx.genericSend<LeaseQueueReleaseRequest>({
      service,
      method: "release",
      key: options.resourceKey,
      parameter: { leaseId: lease.leaseId },
      inputSerde: restate.serde.json,
    });
  }
}

async function getState(
  ctx: restate.ObjectContext | restate.ObjectSharedContext,
): Promise<LeaseQueueState> {
  return (await ctx.get<LeaseQueueState>(STATE_KEY)) ?? emptyLeaseQueueState();
}

function resolveGrantedLeases(
  ctx: restate.ObjectContext,
  leases: LeaseQueueGrant[],
): void {
  for (const lease of leases) {
    const { awakeableId, ...payload } = lease;
    ctx.resolveAwakeable(awakeableId, payload);
  }
}
