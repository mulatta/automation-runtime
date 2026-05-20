export type LeaseQueueItem = {
  awakeableId: string;
  enqueuedAtMs: number;
  leaseId: string;
  leaseTtlMs?: number;
  priority: number;
  requesterId: string;
};

export type LeaseQueueLease = {
  expiresAtMs?: number;
  leaseId: string;
  requesterId: string;
  resourceKey: string;
};

export type LeaseQueueGrant = LeaseQueueLease & {
  awakeableId: string;
};

export type LeaseQueueState = {
  inFlight: Record<string, LeaseQueueLease>;
  maxInFlight: number;
  pending: LeaseQueueItem[];
};

export type LeaseQueueAcquireInput = {
  awakeableId: string;
  leaseTtlMs?: number;
  maxInFlight?: number;
  priority?: number;
  requesterId: string;
};

export type LeaseQueueReleaseInput = {
  leaseId: string;
};

export type LeaseQueueDropInput = {
  awakeableId: string;
};

export type LeaseQueueAcquireDecision = {
  granted: LeaseQueueGrant[];
  state: LeaseQueueState;
};

export type LeaseQueueReleaseDecision = {
  granted: LeaseQueueGrant[];
  released: boolean;
  state: LeaseQueueState;
};

export type LeaseQueueDropDecision = {
  dropped: boolean;
  state: LeaseQueueState;
};

export function emptyLeaseQueueState(): LeaseQueueState {
  return { inFlight: {}, maxInFlight: 1, pending: [] };
}

export function acquireLeaseQueueItem(
  state: LeaseQueueState,
  resourceKey: string,
  request: LeaseQueueAcquireInput,
  leaseId: string,
  nowMs: number,
): LeaseQueueAcquireDecision {
  const next = cloneState(state);
  if (request.maxInFlight !== undefined) {
    next.maxInFlight = Math.max(1, request.maxInFlight);
  }

  const alreadyInFlight = Object.values(next.inFlight).some(
    (lease) => lease.requesterId === request.requesterId,
  );
  const alreadyPending = next.pending.some(
    (item) => item.requesterId === request.requesterId,
  );

  if (!alreadyInFlight && !alreadyPending) {
    next.pending.push({
      awakeableId: request.awakeableId,
      enqueuedAtMs: nowMs,
      leaseId,
      leaseTtlMs: request.leaseTtlMs,
      priority: request.priority ?? 0,
      requesterId: request.requesterId,
    });
  }

  return grantAvailableLeases(next, resourceKey, nowMs);
}

export function releaseLeaseQueueItem(
  state: LeaseQueueState,
  resourceKey: string,
  request: LeaseQueueReleaseInput,
  nowMs: number,
): LeaseQueueReleaseDecision {
  const next = cloneState(state);
  const released = next.inFlight[request.leaseId] !== undefined;
  delete next.inFlight[request.leaseId];
  return { ...grantAvailableLeases(next, resourceKey, nowMs), released };
}

export function dropLeaseQueueItem(
  state: LeaseQueueState,
  request: LeaseQueueDropInput,
): LeaseQueueDropDecision {
  const next = cloneState(state);
  const before = next.pending.length;
  next.pending = next.pending.filter(
    (item) => item.awakeableId !== request.awakeableId,
  );
  return { dropped: next.pending.length !== before, state: next };
}

export function leaseQueueSize(state: LeaseQueueState): {
  inFlight: number;
  pending: number;
} {
  return {
    inFlight: Object.keys(state.inFlight).length,
    pending: state.pending.length,
  };
}

function grantAvailableLeases(
  state: LeaseQueueState,
  resourceKey: string,
  nowMs: number,
): LeaseQueueAcquireDecision {
  const next = cloneState(state);
  const granted: LeaseQueueGrant[] = [];

  while (
    Object.keys(next.inFlight).length < next.maxInFlight &&
    next.pending.length > 0
  ) {
    const index = next.pending.reduce((best, item, candidate) => {
      const current = next.pending[best];
      if (item.priority < current.priority) return candidate;
      if (
        item.priority === current.priority &&
        item.enqueuedAtMs < current.enqueuedAtMs
      ) {
        return candidate;
      }
      return best;
    }, 0);
    const [item] = next.pending.splice(index, 1);
    const lease: LeaseQueueLease = {
      leaseId: item.leaseId,
      requesterId: item.requesterId,
      resourceKey,
      ...(item.leaseTtlMs === undefined
        ? {}
        : { expiresAtMs: nowMs + item.leaseTtlMs }),
    };
    next.inFlight[lease.leaseId] = lease;
    granted.push({ ...lease, awakeableId: item.awakeableId });
  }

  return { granted, state: next };
}

function cloneState(state: LeaseQueueState): LeaseQueueState {
  return {
    inFlight: { ...state.inFlight },
    maxInFlight: state.maxInFlight,
    pending: state.pending.map((item) => ({ ...item })),
  };
}
