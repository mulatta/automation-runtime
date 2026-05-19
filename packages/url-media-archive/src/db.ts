import { z } from "zod";

import { stringifyJsonForPostgres } from "./json";
import { UrlArchiveStatus, UrlProbeStatus } from "./schema";

export type QueryResult<T extends Record<string, unknown>> = {
  rows: T[];
  rowCount: number | null;
};

export type Queryable = {
  query<T extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
};

export type ArchiveJob = {
  id: string;
  url: string;
  canonicalUrl: string;
  status: z.infer<typeof UrlArchiveStatus>;
  probeStatus: z.infer<typeof UrlProbeStatus>;
  attempts: number;
  nextRetryAt: string | null;
};

export type DiscoveredUrlInput = {
  source: string;
  sourceKey?: string;
  url: string;
  canonicalUrl: string;
  sourceUrl?: string;
  sourceCreatedAt?: string;
  discoveredAt?: string;
  metadata?: Record<string, unknown>;
};

export type ArchiveOutputInput = {
  path: string;
  sinkType?: "filesystem";
  bytes?: number;
  mimeType?: string;
  blake3?: string;
  metadata?: Record<string, unknown>;
};

export type ArchiveOutput = Required<Pick<ArchiveOutputInput, "path">> & {
  sinkType: "filesystem";
  bytes?: number;
  mimeType?: string;
  blake3?: string;
  metadata: Record<string, unknown>;
};

export type ArchiveJobDetails = ArchiveJob & {
  error: Record<string, unknown>;
  outputs: ArchiveOutput[];
};

export type PendingSummary = {
  due: number;
  notDue: number;
  byStatus: Partial<Record<z.infer<typeof UrlArchiveStatus>, number>>;
};

export type UpsertDiscoveredUrlResult = {
  job: ArchiveJob;
  sourceId: string;
};

export type ArchiveStore = {
  upsertDiscoveredUrl(
    input: DiscoveredUrlInput,
  ): Promise<UpsertDiscoveredUrlResult>;
  getArchiveJob(id: string): Promise<ArchiveJob | null>;
  getArchiveJobDetails(id: string): Promise<ArchiveJobDetails | null>;
  getArchiveJobByCanonicalUrl(canonicalUrl: string): Promise<ArchiveJob | null>;
  getArchiveJobDetailsByCanonicalUrl(
    canonicalUrl: string,
  ): Promise<ArchiveJobDetails | null>;
  getStatusBySource(
    source: string,
    sourceKey: string,
  ): Promise<ArchiveJob | null>;
  getStatusDetailsBySource(
    source: string,
    sourceKey: string,
  ): Promise<ArchiveJobDetails | null>;
  markProbing(id: string): Promise<ArchiveJob | null>;
  markDownloading(
    id: string,
    metadata?: Record<string, unknown>,
  ): Promise<ArchiveJob | null>;
  markStored(
    id: string,
    outputs: readonly ArchiveOutputInput[],
  ): Promise<ArchiveJob | null>;
  markNoMedia(
    id: string,
    error?: Record<string, unknown>,
  ): Promise<ArchiveJob | null>;
  markFailed(
    id: string,
    error: Record<string, unknown>,
    retryAt?: string | null,
    probeStatus?: z.infer<typeof UrlProbeStatus>,
  ): Promise<ArchiveJob | null>;
  markTerminalFailed(
    id: string,
    error: Record<string, unknown>,
  ): Promise<ArchiveJob | null>;
  listPending(
    limit: number,
    source?: string,
    statuses?: readonly z.infer<typeof UrlArchiveStatus>[],
  ): Promise<ArchiveJob[]>;
  summarizePending(
    source?: string,
    statuses?: readonly z.infer<typeof UrlArchiveStatus>[],
  ): Promise<PendingSummary>;
  insertOutputs(
    jobId: string,
    outputs: readonly ArchiveOutputInput[],
  ): Promise<void>;
};

const ArchiveJobRow = z.object({
  id: z.string().uuid(),
  url: z.string(),
  canonical_url: z.string(),
  status: UrlArchiveStatus,
  probe_status: UrlProbeStatus,
  attempts: z.number().int().nonnegative(),
  next_retry_at: z.union([z.string(), z.date()]).nullable().optional(),
  error: z.record(z.string(), z.unknown()).optional(),
});

const ArchiveOutputRow = z.object({
  path: z.string(),
  sink_type: z.literal("filesystem").or(z.string()),
  bytes: z.union([z.number(), z.string()]).nullable().optional(),
  mime_type: z.string().nullable().optional(),
  blake3: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const PendingSummaryRow = z.object({
  status: UrlArchiveStatus,
  not_due: z.boolean(),
  count: z.union([z.number(), z.string()]),
});

const IdRow = z.object({ id: z.string().uuid() });

export class ArchiveDatabase {
  constructor(private readonly db: Queryable) {}

  async upsertDiscoveredUrl(
    input: DiscoveredUrlInput,
  ): Promise<UpsertDiscoveredUrlResult> {
    const job = await this.upsertArchiveJob(input.url, input.canonicalUrl);
    const sourceId = await this.upsertSource(job.id, input);
    return { job, sourceId };
  }

  async getArchiveJob(id: string): Promise<ArchiveJob | null> {
    const result = await this.db.query(
      `
        SELECT id, url, canonical_url, status, probe_status, attempts, next_retry_at
        FROM url_archive_jobs
        WHERE id = $1
      `,
      [id],
    );
    return parseOptionalJob(result.rows[0]);
  }

  async getArchiveJobDetails(id: string): Promise<ArchiveJobDetails | null> {
    const result = await this.db.query(
      `
        SELECT id, url, canonical_url, status, probe_status, attempts, next_retry_at, error
        FROM url_archive_jobs
        WHERE id = $1
      `,
      [id],
    );
    return await this.parseOptionalJobDetails(result.rows[0]);
  }

  async getArchiveJobByCanonicalUrl(
    canonicalUrl: string,
  ): Promise<ArchiveJob | null> {
    const result = await this.db.query(
      `
        SELECT id, url, canonical_url, status, probe_status, attempts, next_retry_at
        FROM url_archive_jobs
        WHERE canonical_url = $1
      `,
      [canonicalUrl],
    );
    return parseOptionalJob(result.rows[0]);
  }

  async getArchiveJobDetailsByCanonicalUrl(
    canonicalUrl: string,
  ): Promise<ArchiveJobDetails | null> {
    const result = await this.db.query(
      `
        SELECT id, url, canonical_url, status, probe_status, attempts, next_retry_at, error
        FROM url_archive_jobs
        WHERE canonical_url = $1
      `,
      [canonicalUrl],
    );
    return await this.parseOptionalJobDetails(result.rows[0]);
  }

  async getStatusBySource(
    source: string,
    sourceKey: string,
  ): Promise<ArchiveJob | null> {
    const result = await this.db.query(
      `
        SELECT j.id, j.url, j.canonical_url, j.status, j.probe_status, j.attempts, j.next_retry_at
        FROM url_archive_sources s
        JOIN url_archive_jobs j ON j.id = s.job_id
        WHERE s.source = $1 AND s.source_key = $2
      `,
      [source, sourceKey],
    );
    return parseOptionalJob(result.rows[0]);
  }

  async getStatusDetailsBySource(
    source: string,
    sourceKey: string,
  ): Promise<ArchiveJobDetails | null> {
    const result = await this.db.query(
      `
        SELECT j.id, j.url, j.canonical_url, j.status, j.probe_status, j.attempts, j.next_retry_at, j.error
        FROM url_archive_sources s
        JOIN url_archive_jobs j ON j.id = s.job_id
        WHERE s.source = $1 AND s.source_key = $2
      `,
      [source, sourceKey],
    );
    return await this.parseOptionalJobDetails(result.rows[0]);
  }

  async markProbing(id: string): Promise<ArchiveJob | null> {
    const result = await this.db.query(
      `
        UPDATE url_archive_jobs
        SET
          status = 'probing',
          attempts = attempts + 1,
          next_retry_at = null,
          last_attempt_at = now(),
          updated_at = now()
        WHERE id = $1
          AND status NOT IN ('stored', 'no_media', 'terminal_failed', 'skipped')
        RETURNING id, url, canonical_url, status, probe_status, attempts, next_retry_at
      `,
      [id],
    );
    return parseOptionalJob(result.rows[0]);
  }

  async markDownloading(
    id: string,
    metadata: Record<string, unknown> = {},
  ): Promise<ArchiveJob | null> {
    const result = await this.db.query(
      `
        UPDATE url_archive_jobs
        SET
          status = 'downloading',
          probe_status = 'has_media',
          next_retry_at = null,
          ytdlp_metadata = $2::jsonb,
          updated_at = now()
        WHERE id = $1
          AND status NOT IN ('stored', 'no_media', 'terminal_failed', 'skipped')
        RETURNING id, url, canonical_url, status, probe_status, attempts, next_retry_at
      `,
      [id, stringifyJsonForPostgres(metadata)],
    );
    return parseOptionalJob(result.rows[0]);
  }

  async markStored(
    id: string,
    outputs: readonly ArchiveOutputInput[],
  ): Promise<ArchiveJob | null> {
    for (const output of outputs) {
      await this.insertOutput(id, output);
    }

    const result = await this.db.query(
      `
        UPDATE url_archive_jobs
        SET
          status = 'stored',
          probe_status = 'has_media',
          stored_at = now(),
          next_retry_at = null,
          updated_at = now(),
          error = '{}'::jsonb
        WHERE id = $1
          AND status NOT IN ('terminal_failed', 'skipped')
        RETURNING id, url, canonical_url, status, probe_status, attempts, next_retry_at
      `,
      [id],
    );
    return parseOptionalJob(result.rows[0]);
  }

  async markNoMedia(
    id: string,
    error: Record<string, unknown> = {},
  ): Promise<ArchiveJob | null> {
    const result = await this.db.query(
      `
        UPDATE url_archive_jobs
        SET
          status = 'no_media',
          probe_status = 'no_media',
          next_retry_at = null,
          updated_at = now(),
          error = $2::jsonb
        WHERE id = $1
          AND status NOT IN ('stored', 'terminal_failed', 'skipped')
        RETURNING id, url, canonical_url, status, probe_status, attempts, next_retry_at
      `,
      [id, stringifyJsonForPostgres(error)],
    );
    return parseOptionalJob(result.rows[0]);
  }

  async markFailed(
    id: string,
    error: Record<string, unknown>,
    retryAt?: string | null,
    probeStatus?: z.infer<typeof UrlProbeStatus>,
  ): Promise<ArchiveJob | null> {
    const result = await this.db.query(
      `
        UPDATE url_archive_jobs
        SET
          status = 'failed',
          probe_status = COALESCE($4::url_probe_status, probe_status),
          next_retry_at = $2::timestamptz,
          updated_at = now(),
          error = $3::jsonb
        WHERE id = $1
          AND status NOT IN ('stored', 'no_media', 'terminal_failed', 'skipped')
        RETURNING id, url, canonical_url, status, probe_status, attempts, next_retry_at
      `,
      [
        id,
        retryAt ?? null,
        stringifyJsonForPostgres(error),
        probeStatus ?? null,
      ],
    );
    return parseOptionalJob(result.rows[0]);
  }

  async markTerminalFailed(
    id: string,
    error: Record<string, unknown>,
  ): Promise<ArchiveJob | null> {
    const result = await this.db.query(
      `
        UPDATE url_archive_jobs
        SET
          status = 'terminal_failed',
          next_retry_at = null,
          updated_at = now(),
          error = $2::jsonb
        WHERE id = $1
          AND status NOT IN ('stored', 'no_media', 'terminal_failed', 'skipped')
        RETURNING id, url, canonical_url, status, probe_status, attempts, next_retry_at
      `,
      [id, stringifyJsonForPostgres(error)],
    );
    return parseOptionalJob(result.rows[0]);
  }

  async listPending(
    limit: number,
    source?: string,
    statuses: readonly z.infer<typeof UrlArchiveStatus>[] = [
      "pending",
      "failed",
    ],
  ): Promise<ArchiveJob[]> {
    const values: unknown[] = [limit, statuses];
    const sourceFilter = source ? "AND s.source = $3" : "";
    if (source) values.push(source);

    const result = await this.db.query(
      `
        SELECT DISTINCT j.id, j.url, j.canonical_url, j.status, j.probe_status, j.attempts, j.next_retry_at, j.created_at
        FROM url_archive_jobs j
        LEFT JOIN url_archive_sources s ON s.job_id = j.id
        WHERE j.status = ANY($2::url_archive_status[])
          AND (j.status <> 'failed' OR j.next_retry_at IS NULL OR j.next_retry_at <= now())
          ${sourceFilter}
        ORDER BY j.created_at ASC
        LIMIT $1
      `,
      values,
    );
    return result.rows.map(parseJob);
  }

  async summarizePending(
    source?: string,
    statuses: readonly z.infer<typeof UrlArchiveStatus>[] = [
      "pending",
      "failed",
    ],
  ): Promise<PendingSummary> {
    const values: unknown[] = [statuses];
    const sourceFilter = source ? "AND s.source = $2" : "";
    if (source) values.push(source);

    const result = await this.db.query(
      `
        SELECT
          j.status,
          (j.status = 'failed' AND j.next_retry_at > now()) AS not_due,
          count(DISTINCT j.id) AS count
        FROM url_archive_jobs j
        LEFT JOIN url_archive_sources s ON s.job_id = j.id
        WHERE j.status = ANY($1::url_archive_status[])
          ${sourceFilter}
        GROUP BY j.status, not_due
      `,
      values,
    );
    return parsePendingSummary(result.rows);
  }

  async insertOutputs(
    jobId: string,
    outputs: readonly ArchiveOutputInput[],
  ): Promise<void> {
    for (const output of outputs) {
      await this.insertOutput(jobId, output);
    }
  }

  private async parseOptionalJobDetails(
    row: Record<string, unknown> | undefined,
  ): Promise<ArchiveJobDetails | null> {
    if (!row) return null;
    const job = parseJobDetails(row);
    return {
      ...job,
      outputs: await this.listOutputs(job.id),
    };
  }

  private async listOutputs(jobId: string): Promise<ArchiveOutput[]> {
    const result = await this.db.query(
      `
        SELECT path, sink_type, bytes, mime_type, blake3, metadata
        FROM url_archive_outputs
        WHERE job_id = $1
        ORDER BY created_at ASC, path ASC
      `,
      [jobId],
    );
    return result.rows.map(parseOutput);
  }

  private async upsertArchiveJob(
    url: string,
    canonicalUrl: string,
  ): Promise<ArchiveJob> {
    const result = await this.db.query(
      `
        INSERT INTO url_archive_jobs (url, canonical_url)
        VALUES ($1, $2)
        ON CONFLICT (canonical_url) DO UPDATE
          SET url = EXCLUDED.url,
              updated_at = now()
        RETURNING id, url, canonical_url, status, probe_status, attempts, next_retry_at
      `,
      [url, canonicalUrl],
    );
    return parseJob(result.rows[0]);
  }

  private async upsertSource(
    jobId: string,
    input: DiscoveredUrlInput,
  ): Promise<string> {
    const values = [
      jobId,
      input.source,
      input.sourceKey ?? null,
      input.sourceUrl ?? input.url,
      input.sourceCreatedAt ?? null,
      input.discoveredAt ?? null,
      stringifyJsonForPostgres(input.metadata ?? {}),
    ];

    const text = input.sourceKey
      ? `
        INSERT INTO url_archive_sources (
          job_id, source, source_key, source_url, source_created_at, discovered_at, metadata
        )
        VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7::jsonb)
        ON CONFLICT (source, source_key) DO UPDATE
          SET job_id = EXCLUDED.job_id,
              source_url = EXCLUDED.source_url,
              source_created_at = COALESCE(EXCLUDED.source_created_at, url_archive_sources.source_created_at),
              metadata = EXCLUDED.metadata,
              updated_at = now()
        RETURNING id
      `
      : `
        INSERT INTO url_archive_sources (
          job_id, source, source_key, source_url, source_created_at, discovered_at, metadata
        )
        VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7::jsonb)
        RETURNING id
      `;

    const result = await this.db.query(text, values);
    return IdRow.parse(result.rows[0]).id;
  }

  private async insertOutput(
    jobId: string,
    output: ArchiveOutputInput,
  ): Promise<void> {
    await this.db.query(
      `
        INSERT INTO url_archive_outputs (
          job_id, sink_type, path, bytes, mime_type, blake3, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (job_id, path) DO NOTHING
        RETURNING id
      `,
      [
        jobId,
        output.sinkType ?? "filesystem",
        output.path,
        output.bytes ?? null,
        output.mimeType ?? null,
        output.blake3 ?? null,
        stringifyJsonForPostgres(output.metadata ?? {}),
      ],
    );
  }
}

function parseOptionalJob(
  row: Record<string, unknown> | undefined,
): ArchiveJob | null {
  return row ? parseJob(row) : null;
}

function parseJob(row: Record<string, unknown> | undefined): ArchiveJob {
  const parsed = ArchiveJobRow.parse(row);
  return {
    id: parsed.id,
    url: parsed.url,
    canonicalUrl: parsed.canonical_url,
    status: parsed.status,
    probeStatus: parsed.probe_status,
    attempts: parsed.attempts,
    nextRetryAt: dateTimeToIso(parsed.next_retry_at),
  };
}

function parseJobDetails(
  row: Record<string, unknown> | undefined,
): Omit<ArchiveJobDetails, "outputs"> {
  const parsed = ArchiveJobRow.parse(row);
  return {
    ...parseJob(row),
    error: parsed.error ?? {},
  };
}

function parseOutput(row: Record<string, unknown> | undefined): ArchiveOutput {
  const parsed = ArchiveOutputRow.parse(row);
  return {
    path: parsed.path,
    sinkType: "filesystem",
    bytes: numberFromDatabase(parsed.bytes),
    mimeType: parsed.mime_type ?? undefined,
    blake3: parsed.blake3 ?? undefined,
    metadata: parsed.metadata ?? {},
  };
}

function parsePendingSummary(rows: Record<string, unknown>[]): PendingSummary {
  const summary: PendingSummary = { due: 0, notDue: 0, byStatus: {} };
  for (const row of rows) {
    const parsed = PendingSummaryRow.parse(row);
    const count = numberFromDatabase(parsed.count) ?? 0;
    if (parsed.not_due) {
      summary.notDue += count;
    } else {
      summary.due += count;
      summary.byStatus[parsed.status] =
        (summary.byStatus[parsed.status] ?? 0) + count;
    }
  }
  return summary;
}

function numberFromDatabase(
  value: string | number | null | undefined,
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function dateTimeToIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}
