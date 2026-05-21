import {
  ArchiveDatabase,
  type ArchiveOutputInput,
  type Queryable,
  type QueryResult,
} from "../src/db";

type QueryCall = {
  text: string;
  values: readonly unknown[];
};

class ScriptedClient implements Queryable {
  readonly calls: QueryCall[] = [];

  constructor(
    private readonly results: Array<QueryResult<Record<string, unknown>>>,
  ) {}

  async query<T extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    this.calls.push({ text, values });
    const result = this.results.shift();
    if (!result) throw new Error(`unexpected query: ${text}`);
    return Promise.resolve(result as QueryResult<T>);
  }
}

function rows<T extends Record<string, unknown>>(
  ...items: T[]
): QueryResult<T> {
  return { rows: items, rowCount: items.length };
}

describe("ArchiveDatabase", () => {
  it("upserts discovered URLs through canonical archive jobs and source rows", async () => {
    const client = new ScriptedClient([
      rows({
        id: "018f6e9d-4a31-7565-982a-cb5e5f01d31f",
        url: "https://example.com/media/123",
        canonical_url: "https://example.com/media/123",
        status: "pending",
        probe_status: "unknown",
        attempts: 0,
      }),
      rows({ id: "018f6e9d-4a31-7565-982a-cb5e5f01d320" }),
    ]);
    const db = new ArchiveDatabase(client);

    const result = await db.upsertDiscoveredUrl({
      source: "example-feed",
      sourceKey: "123",
      url: "https://example.com/media/123",
      canonicalUrl: "https://example.com/media/123",
      sourceCreatedAt: "2026-05-18T00:00:00.000Z",
      metadata: { author: "user" },
    });

    expect(result.job.id).toBe("018f6e9d-4a31-7565-982a-cb5e5f01d31f");
    expect(result.sourceId).toBe("018f6e9d-4a31-7565-982a-cb5e5f01d320");
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]?.text).toContain("INSERT INTO url_archive_jobs");
    expect(client.calls[0]?.text).toContain("ON CONFLICT (canonical_url)");
    expect(client.calls[1]?.text).toContain("INSERT INTO url_archive_sources");
    expect(client.calls[1]?.text).toContain("ON CONFLICT (source, source_key)");
  });

  it("looks up jobs by canonical URL for direct URL submissions", async () => {
    const client = new ScriptedClient([
      rows({
        id: "018f6e9d-4a31-7565-982a-cb5e5f01d31f",
        url: "https://example.com/media/123?utm_source=test",
        canonical_url: "https://example.com/media/123",
        status: "stored",
        probe_status: "has_media",
        attempts: 1,
      }),
    ]);
    const db = new ArchiveDatabase(client);

    const job = await db.getArchiveJobByCanonicalUrl(
      "https://example.com/media/123",
    );

    expect(job?.id).toBe("018f6e9d-4a31-7565-982a-cb5e5f01d31f");
    expect(client.calls[0]?.text).toContain("WHERE canonical_url = $1");
    expect(client.calls[0]?.values).toEqual(["https://example.com/media/123"]);
  });

  it("returns status details with stored outputs and errors", async () => {
    const client = new ScriptedClient([
      rows({
        id: "018f6e9d-4a31-7565-982a-cb5e5f01d31f",
        url: "https://example.com/media/123",
        canonical_url: "https://example.com/media/123",
        status: "stored",
        probe_status: "has_media",
        attempts: 1,
        error: {},
      }),
      rows({
        path: "/var/lib/url-media-archive/archive/db/2026/05/job/video.mp4",
        sink_type: "filesystem",
        bytes: "1024",
        mime_type: "video/mp4",
        blake3: "abc",
        metadata: { title: "Video" },
      }),
    ]);
    const db = new ArchiveDatabase(client);

    const details = await db.getArchiveJobDetails(
      "018f6e9d-4a31-7565-982a-cb5e5f01d31f",
    );

    expect(details?.error).toEqual({});
    expect(details?.outputs).toEqual([
      {
        path: "/var/lib/url-media-archive/archive/db/2026/05/job/video.mp4",
        sinkType: "filesystem",
        bytes: 1024,
        mimeType: "video/mp4",
        blake3: "abc",
        metadata: { title: "Video" },
      },
    ]);
    expect(client.calls[0]?.text).toContain("error");
    expect(client.calls[1]?.text).toContain("FROM url_archive_outputs");
  });

  it("does not move terminal jobs back to probing", async () => {
    const client = new ScriptedClient([rows()]);
    const db = new ArchiveDatabase(client);

    await expect(
      db.markProbing("018f6e9d-4a31-7565-982a-cb5e5f01d31f"),
    ).resolves.toBeNull();

    expect(client.calls[0]?.text).toContain(
      "status NOT IN ('stored', 'no_media', 'terminal_failed', 'skipped')",
    );
  });

  it("stores yt-dlp metadata when marking jobs ready for download", async () => {
    const client = new ScriptedClient([
      rows({
        id: "018f6e9d-4a31-7565-982a-cb5e5f01d31f",
        url: "https://example.com/media/123",
        canonical_url: "https://example.com/media/123",
        status: "downloading",
        probe_status: "has_media",
        attempts: 1,
      }),
    ]);
    const db = new ArchiveDatabase(client);

    await db.markDownloading("018f6e9d-4a31-7565-982a-cb5e5f01d31f", {
      extractor: "test",
    });

    expect(client.calls[0]?.text).toContain("ytdlp_metadata = $2::jsonb");
    expect(client.calls[0]?.values[1]).toBe('{"extractor":"test"}');
  });

  it("marks retryable failures with due retry timestamps", async () => {
    const client = new ScriptedClient([
      rows({
        id: "018f6e9d-4a31-7565-982a-cb5e5f01d31f",
        url: "https://example.com/media/123",
        canonical_url: "https://example.com/media/123",
        status: "failed",
        probe_status: "has_media",
        attempts: 1,
        next_retry_at: "2026-05-18T00:05:00.000Z",
      }),
    ]);
    const db = new ArchiveDatabase(client);

    const job = await db.markFailed(
      "018f6e9d-4a31-7565-982a-cb5e5f01d31f",
      { type: "retryable_network_timeout" },
      "2026-05-18T00:05:00.000Z",
    );

    expect(job?.nextRetryAt).toBe("2026-05-18T00:05:00.000Z");
    expect(client.calls[0]?.text).toContain("status = 'failed'");
    expect(client.calls[0]?.text).toContain("next_retry_at = $2::timestamptz");
    expect(client.calls[0]?.values[1]).toBe("2026-05-18T00:05:00.000Z");
  });

  it("summarizes due and not-due pending work", async () => {
    const client = new ScriptedClient([
      rows(
        { status: "pending", not_due: false, count: "2" },
        { status: "failed", not_due: false, count: "3" },
        { status: "failed", not_due: true, count: "4" },
      ),
    ]);
    const db = new ArchiveDatabase(client);

    const summary = await db.summarizePending("example-feed", [
      "pending",
      "failed",
    ]);

    expect(summary).toEqual({
      due: 5,
      notDue: 4,
      byStatus: { pending: 2, failed: 3 },
    });
    expect(client.calls[0]?.text).toContain("count(DISTINCT j.id)");
    expect(client.calls[0]?.text).toContain("AND s.source = $2");
    expect(client.calls[0]?.values).toEqual([
      ["pending", "failed"],
      "example-feed",
    ]);
  });

  it("reads and resets source discovery state", async () => {
    const client = new ScriptedClient([
      rows({
        source: "x-liked",
        version: "3",
        next_token: "cursor",
        coverage_complete: true,
        catchup_incomplete: false,
        anchor_ids: ["1", "2"],
        current_run: { pages_seen: 1 },
        last_checked_at: "2026-05-18T00:00:00.000Z",
        last_discovered_count: 4,
        last_submitted_count: 5,
        last_status_checked_at: null,
      }),
      rows({
        source: "x-liked",
        version: "4",
        next_token: "",
        coverage_complete: true,
        catchup_incomplete: false,
        anchor_ids: ["1", "2"],
        current_run: null,
        last_checked_at: "2026-05-18T00:00:00.000Z",
        last_discovered_count: 4,
        last_submitted_count: 5,
        last_status_checked_at: null,
      }),
    ]);
    const db = new ArchiveDatabase(client);

    await expect(db.getDiscoveryState("x-liked")).resolves.toMatchObject({
      source: "x-liked",
      version: 3,
      nextToken: "cursor",
      currentRun: { pages_seen: 1 },
    });
    await expect(db.startDiscoveryScan("x-liked", true)).resolves.toMatchObject(
      {
        source: "x-liked",
        version: 4,
        nextToken: "",
        currentRun: null,
      },
    );

    expect(client.calls[0]?.text).toContain(
      "INSERT INTO url_archive_discovery_states",
    );
    expect(client.calls[1]?.text).toContain("next_token = ''");
  });

  it("records discovery pages with source-key boundary detection and cursor state", async () => {
    const client = new ScriptedClient([
      rows({
        source: "x-liked",
        version: "2",
        next_token: "",
        coverage_complete: true,
        catchup_incomplete: false,
        anchor_ids: [],
        current_run: null,
        last_checked_at: null,
        last_discovered_count: 0,
        last_submitted_count: 0,
        last_status_checked_at: null,
      }),
      rows({ source_key: "known" }),
      rows({
        id: "018f6e9d-4a31-7565-982a-cb5e5f01d31f",
        url: "https://x.com/i/status/known",
        canonical_url: "https://x.com/i/status/known",
        status: "pending",
        probe_status: "unknown",
        attempts: 0,
      }),
      rows({ id: "018f6e9d-4a31-7565-982a-cb5e5f01d320" }),
      rows({
        id: "118f6e9d-4a31-7565-982a-cb5e5f01d31f",
        url: "https://x.com/i/status/new",
        canonical_url: "https://x.com/i/status/new",
        status: "pending",
        probe_status: "unknown",
        attempts: 0,
      }),
      rows({ id: "118f6e9d-4a31-7565-982a-cb5e5f01d320" }),
      rows({
        source: "x-liked",
        version: "3",
        next_token: "next",
        coverage_complete: false,
        catchup_incomplete: true,
        anchor_ids: ["known", "new"],
        current_run: {
          pages_seen: 1,
          discovered_count: 1,
          submitted_count: 2,
          started_from_cursor: false,
          started_at: "2026-05-18T00:00:00.000Z",
        },
        last_checked_at: "2026-05-18T00:00:01.000Z",
        last_discovered_count: 1,
        last_submitted_count: 2,
        last_status_checked_at: null,
      }),
    ]);
    const db = new ArchiveDatabase(client);

    const result = await db.recordDiscoveryPage({
      source: "x-liked",
      stateVersion: 2,
      pageSize: 10,
      pagesPerRun: 10,
      fullCoverage: false,
      startedFromCursor: false,
      scanStartedAt: "2026-05-18T00:00:00.000Z",
      observedAt: "2026-05-18T00:00:01.000Z",
      paginationToken: "",
      nextToken: "next",
      items: [
        { sourceKey: "known", url: "https://x.com/i/status/known" },
        { sourceKey: "new", url: "https://x.com/i/status/new" },
      ],
    });

    expect(result.pageDiscoveredCount).toBe(1);
    expect(result.continuePagination).toBe(false);
    expect(result.savedCursor).toBe("");
    expect(result.jobs).toHaveLength(2);
    expect(client.calls[1]?.text).toContain("FROM url_archive_sources");
    expect(client.calls[6]?.text).toContain("version = version + 1");
    expect(client.calls[6]?.values).toContain(2);
  });

  it("lists only selected pending statuses and due retryable failures", async () => {
    const client = new ScriptedClient([
      rows({
        id: "018f6e9d-4a31-7565-982a-cb5e5f01d31f",
        url: "https://example.com/media/123",
        canonical_url: "https://example.com/media/123",
        status: "failed",
        probe_status: "has_media",
        attempts: 1,
        next_retry_at: new Date("2026-05-18T00:05:00.000Z"),
      }),
    ]);
    const db = new ArchiveDatabase(client);

    const jobs = await db.listPending(10, "example-feed", ["failed"]);

    expect(jobs[0]?.nextRetryAt).toBe("2026-05-18T00:05:00.000Z");
    expect(client.calls[0]?.text).toContain(
      "j.status = ANY($2::url_archive_status[])",
    );
    expect(client.calls[0]?.text).toContain("j.next_retry_at <= now()");
    expect(client.calls[0]?.text).toContain("AND s.source = $3");
    expect(client.calls[0]?.values).toEqual([10, ["failed"], "example-feed"]);
  });

  it("lists due pending work for one URL host", async () => {
    const client = new ScriptedClient([
      rows({
        id: "018f6e9d-4a31-7565-982a-cb5e5f01d31f",
        url: "https://example.com/media/123",
        canonical_url: "https://example.com/media/123",
        status: "failed",
        probe_status: "has_media",
        attempts: 1,
        next_retry_at: null,
      }),
    ]);
    const db = new ArchiveDatabase(client);

    const jobs = await db.listPendingByHost("EXAMPLE.com", 1, "example-feed", [
      "failed",
    ]);

    expect(jobs[0]?.id).toBe("018f6e9d-4a31-7565-982a-cb5e5f01d31f");
    expect(client.calls[0]?.text).toContain("regexp_replace(j.canonical_url");
    expect(client.calls[0]?.text).toContain("AND s.source = $4");
    expect(client.calls[0]?.values).toEqual([
      1,
      ["failed"],
      "example.com",
      "example-feed",
    ]);
  });

  it("marks terminal failures without allowing retry drain", async () => {
    const client = new ScriptedClient([
      rows({
        id: "018f6e9d-4a31-7565-982a-cb5e5f01d31f",
        url: "https://example.com/media/123",
        canonical_url: "https://example.com/media/123",
        status: "terminal_failed",
        probe_status: "has_media",
        attempts: 1,
      }),
    ]);
    const db = new ArchiveDatabase(client);

    await db.markTerminalFailed("018f6e9d-4a31-7565-982a-cb5e5f01d31f", {
      type: "terminal_auth_cookie_invalid",
    });

    expect(client.calls[0]?.text).toContain("status = 'terminal_failed'");
    expect(client.calls[0]?.values[1]).toBe(
      '{"type":"terminal_auth_cookie_invalid"}',
    );
  });

  it("sanitizes invalid Unicode before jsonb writes", async () => {
    const client = new ScriptedClient([
      rows({
        id: "018f6e9d-4a31-7565-982a-cb5e5f01d31f",
        url: "https://example.com/media/123",
        canonical_url: "https://example.com/media/123",
        status: "terminal_failed",
        probe_status: "has_media",
        attempts: 1,
      }),
    ]);
    const db = new ArchiveDatabase(client);

    await db.markTerminalFailed("018f6e9d-4a31-7565-982a-cb5e5f01d31f", {
      type: "terminal_auth_cookie_invalid",
      message: "broken title \ud835",
    });

    expect(client.calls[0]?.values[1]).toBe(
      '{"type":"terminal_auth_cookie_invalid","message":"broken title �"}',
    );
  });

  it("inserts outputs idempotently before marking jobs stored", async () => {
    const outputs: ArchiveOutputInput[] = [
      {
        path: "/var/lib/url-media-archive/archive/db/2026/05/123/video.mp4",
        bytes: 1024,
        mimeType: "video/mp4",
        blake3: "abc",
        metadata: { ext: "mp4" },
      },
    ];
    const client = new ScriptedClient([
      rows({ id: "output-id" }),
      rows({
        id: "018f6e9d-4a31-7565-982a-cb5e5f01d31f",
        url: "https://example.com/media/123",
        canonical_url: "https://example.com/media/123",
        status: "stored",
        probe_status: "has_media",
        attempts: 1,
      }),
    ]);
    const db = new ArchiveDatabase(client);

    await db.markStored("018f6e9d-4a31-7565-982a-cb5e5f01d31f", outputs);

    expect(client.calls[0]?.text).toContain("INSERT INTO url_archive_outputs");
    expect(client.calls[0]?.text).toContain(
      "ON CONFLICT (job_id, path) DO NOTHING",
    );
    expect(client.calls[1]?.text).toContain("status = 'stored'");
  });
});
