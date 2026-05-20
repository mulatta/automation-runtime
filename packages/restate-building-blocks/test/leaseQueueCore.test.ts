import {
  acquireLeaseQueueItem,
  dropLeaseQueueItem,
  emptyLeaseQueueState,
  releaseLeaseQueueItem,
} from "../src/leaseQueueCore";

describe("lease queue core", () => {
  it("grants up to maxInFlight and queues the rest", () => {
    let state = emptyLeaseQueueState();
    let decision = acquireLeaseQueueItem(
      state,
      "example.com",
      { awakeableId: "a1", maxInFlight: 1, requesterId: "job-1" },
      "lease-1",
      1000,
    );

    expect(decision.granted).toEqual([
      {
        awakeableId: "a1",
        leaseId: "lease-1",
        requesterId: "job-1",
        resourceKey: "example.com",
      },
    ]);
    expect(decision.state.inFlight).toHaveProperty("lease-1");

    state = decision.state;
    decision = acquireLeaseQueueItem(
      state,
      "example.com",
      { awakeableId: "a2", maxInFlight: 1, requesterId: "job-2" },
      "lease-2",
      2000,
    );

    expect(decision.granted).toEqual([]);
    expect(decision.state.pending).toHaveLength(1);
  });

  it("releases a lease and grants the next pending requester", () => {
    let state = emptyLeaseQueueState();
    state = acquireLeaseQueueItem(
      state,
      "example.com",
      { awakeableId: "a1", requesterId: "job-1" },
      "lease-1",
      1000,
    ).state;
    state = acquireLeaseQueueItem(
      state,
      "example.com",
      { awakeableId: "a2", requesterId: "job-2" },
      "lease-2",
      2000,
    ).state;

    const decision = releaseLeaseQueueItem(
      state,
      "example.com",
      { leaseId: "lease-1" },
      3000,
    );

    expect(decision.released).toBe(true);
    expect(decision.granted).toEqual([
      {
        awakeableId: "a2",
        leaseId: "lease-2",
        requesterId: "job-2",
        resourceKey: "example.com",
      },
    ]);
    expect(decision.state.pending).toHaveLength(0);
    expect(decision.state.inFlight).not.toHaveProperty("lease-1");
    expect(decision.state.inFlight).toHaveProperty("lease-2");
  });

  it("prefers lower priority and then FIFO", () => {
    let state = emptyLeaseQueueState();
    state = acquireLeaseQueueItem(
      state,
      "example.com",
      { awakeableId: "active", requesterId: "active" },
      "lease-active",
      1000,
    ).state;
    state = acquireLeaseQueueItem(
      state,
      "example.com",
      { awakeableId: "slow", priority: 10, requesterId: "slow" },
      "lease-slow",
      2000,
    ).state;
    state = acquireLeaseQueueItem(
      state,
      "example.com",
      { awakeableId: "fast", priority: 1, requesterId: "fast" },
      "lease-fast",
      3000,
    ).state;

    const decision = releaseLeaseQueueItem(
      state,
      "example.com",
      { leaseId: "lease-active" },
      4000,
    );

    expect(decision.granted[0]).toMatchObject({ requesterId: "fast" });
    expect(decision.state.pending[0]).toMatchObject({ requesterId: "slow" });
  });

  it("deduplicates requester IDs", () => {
    let state = emptyLeaseQueueState();
    state = acquireLeaseQueueItem(
      state,
      "example.com",
      { awakeableId: "a1", requesterId: "job-1" },
      "lease-1",
      1000,
    ).state;

    const decision = acquireLeaseQueueItem(
      state,
      "example.com",
      { awakeableId: "a1-dup", requesterId: "job-1" },
      "lease-dup",
      2000,
    );

    expect(decision.granted).toEqual([]);
    expect(decision.state.pending).toHaveLength(0);
    expect(decision.state.inFlight).not.toHaveProperty("lease-dup");
  });

  it("drops a pending awakeable", () => {
    let state = emptyLeaseQueueState();
    state = acquireLeaseQueueItem(
      state,
      "example.com",
      { awakeableId: "active", requesterId: "active" },
      "lease-active",
      1000,
    ).state;
    state = acquireLeaseQueueItem(
      state,
      "example.com",
      { awakeableId: "pending", requesterId: "pending" },
      "lease-pending",
      2000,
    ).state;

    const decision = dropLeaseQueueItem(state, { awakeableId: "pending" });

    expect(decision.dropped).toBe(true);
    expect(decision.state.pending).toHaveLength(0);
  });

  it("sets lease expiry when ttl is provided", () => {
    const decision = acquireLeaseQueueItem(
      emptyLeaseQueueState(),
      "example.com",
      { awakeableId: "a1", leaseTtlMs: 5000, requesterId: "job-1" },
      "lease-1",
      1000,
    );

    expect(decision.granted[0]).toMatchObject({ expiresAtMs: 6000 });
    expect(decision.state.inFlight["lease-1"]).toMatchObject({
      expiresAtMs: 6000,
    });
  });
});
