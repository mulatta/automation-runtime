import { AsyncSemaphore } from "../src/semaphore";

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}

describe("AsyncSemaphore", () => {
  it("limits concurrent operations", async () => {
    const semaphore = new AsyncSemaphore(2);
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;

    const operations = Array.from({ length: 5 }, () =>
      semaphore.runExclusive(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
      }),
    );

    await waitUntil(() => releases.length === 2);
    expect(semaphore.activeCount).toBe(2);
    expect(semaphore.pendingCount).toBe(3);

    while (releases.length > 0) {
      releases.shift()?.();
      await waitUntil(
        () => releases.length > 0 || semaphore.pendingCount === 0,
      );
    }

    await Promise.all(operations);
    expect(maxActive).toBe(2);
    expect(semaphore.activeCount).toBe(0);
    expect(semaphore.pendingCount).toBe(0);
  });

  it("rejects invalid limits", () => {
    expect(() => new AsyncSemaphore(0)).toThrow("Invalid semaphore limit: 0");
  });
});
