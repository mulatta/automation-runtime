import * as restate from "@restatedev/restate-sdk";

import { downloadTempDir } from "./archivePaths";
import type {
  ArchiveJob,
  ArchiveJobDetails,
  ArchiveOutputInput,
  ArchiveStore,
  PendingSummary,
} from "./db";
import {
  calculateNextRetryAt,
  classifyArchiveError,
  type ArchiveFailure,
  type ArchiveFailureKind,
} from "./errors";
import type { YtDlpDownloadResult, YtDlpProbeResult } from "./ytdlp";
import { canonicalizeUrl, jobIdFromJobKey, jobKeyForJobId } from "./ids";
import {
  DrainPendingRequest,
  RateLimitReserveRequest,
  UrlMediaJobRunRequest,
  StatusBySourceRequest,
  StatusRequest,
  SubmitDiscoveredUrlRequest,
  SubmitJobRequest,
  SubmitUrlRequest,
  type ArchiveJobSnapshot,
  type RateLimitReservation,
  type WorkerStatus,
} from "./schema";
import { assertSafeArchiveUrl } from "./urlSafety";

const WORKER_VERSION = "0.1.0";
const URL_MEDIA_JOB_SERVICE = "UrlMediaJob";
const URL_MEDIA_RATE_LIMIT_SERVICE = "UrlMediaArchiveRateLimit";
const RUN_METHOD = "run";

type MediaProber = {
  probe(url: string): Promise<YtDlpProbeResult>;
};

type MediaDownloader = {
  download(url: string, targetDir: string): Promise<YtDlpDownloadResult>;
};

type FilesystemSink = {
  store(input: {
    archiveRoot: string;
    jobKey: string;
    mode: "db" | "url";
    canonicalUrl: string;
    downloadedFiles: readonly string[];
    metadata?: Record<string, unknown>;
    observedAt: string;
  }): Promise<ArchiveOutputInput[]>;
};

type TempDirCleaner = {
  cleanup(archiveRoot: string, jobKey: string): Promise<void>;
};

type FinalDirCleaner = {
  cleanup(
    archiveRoot: string,
    jobKey: string,
    observedAt: string,
  ): Promise<void>;
};

type UrlMediaArchiveDeps = {
  db?: ArchiveStore;
  prober?: MediaProber;
  downloader?: MediaDownloader;
  sink?: FilesystemSink;
  cleanupFinalDir?: FinalDirCleaner;
  cleanupTempDir?: TempDirCleaner;
  archiveRoot?: string;
  keepFailedTempDirs?: boolean;
  ytDlpRequestMinIntervalMs?: number;
};

type SubmitAccepted = {
  accepted: true;
  jobKey: string;
  jobId?: string;
  sourceId?: string;
};

type DrainResult = PendingSummary & {
  accepted: number;
  skipped: number;
  jobKeys: string[];
};

type ArchiveMediaResult =
  | { outputs: ArchiveOutputInput[]; failure?: undefined }
  | {
      outputs?: undefined;
      failure: ArchiveFailure;
      finalDirObservedAt?: string;
    };

type UrlMediaJobState = {
  jobKey: string;
  mode: "db" | "url";
  url: string;
  canonicalUrl: string;
  status: string;
  updatedAt: string;
  jobId?: string;
  probeStatus?: string;
  probeError?: Record<string, unknown>;
  outputs?: ArchiveOutputInput[];
  nextRetryAt?: string | null;
};

const COMPLETED_OR_TERMINAL = new Set([
  "stored",
  "no_media",
  "terminal_failed",
  "skipped",
]);

export function createUrlMediaArchive(deps: UrlMediaArchiveDeps = {}) {
  return restate.service({
    name: "UrlMediaArchive",
    handlers: {
      submitDiscoveredUrl: async (
        ctx: restate.Context,
        input: unknown,
      ): Promise<SubmitAccepted> => {
        const request = SubmitDiscoveredUrlRequest.parse(input);
        assertSafeArchiveUrl(request.url);
        const canonicalUrl = canonicalizeUrl(request.url);
        const db = requireDatabase(deps);

        const upserted = await ctx.run("upsert-discovered-url", () =>
          db.upsertDiscoveredUrl({
            ...request,
            canonicalUrl,
          }),
        );
        const jobKey = jobKeyForJobId(upserted.job.id);

        sendUrlMediaJob(
          ctx,
          jobKey,
          {
            mode: "db",
            job: toJobSnapshot(upserted.job),
          },
          urlMediaJobRunIdempotencyKey(jobKey, upserted.job),
        );

        return {
          accepted: true,
          jobKey,
          jobId: upserted.job.id,
          sourceId: upserted.sourceId,
        };
      },

      submitJob: async (
        ctx: restate.Context,
        input: unknown,
      ): Promise<SubmitAccepted> => {
        const request = SubmitJobRequest.parse(input);
        const db = requireDatabase(deps);
        const job = await ctx.run("get-archive-job", () =>
          db.getArchiveJob(request.jobId),
        );
        if (!job) {
          throw new restate.TerminalError(
            `Archive job not found: ${request.jobId}`,
            {
              errorCode: 404,
            },
          );
        }

        const jobKey = jobKeyForJobId(job.id);
        sendUrlMediaJob(
          ctx,
          jobKey,
          {
            mode: "db",
            job: toJobSnapshot(job),
          },
          urlMediaJobRunIdempotencyKey(jobKey, job),
        );

        return { accepted: true, jobKey, jobId: job.id };
      },

      submitUrl: async (
        ctx: restate.Context,
        input: unknown,
      ): Promise<SubmitAccepted> => {
        const request = SubmitUrlRequest.parse(input);
        assertSafeArchiveUrl(request.url);
        const canonicalUrl = canonicalizeUrl(request.url);
        const db = requireDatabase(deps);

        const upserted = await ctx.run("upsert-submitted-url", () =>
          db.upsertDiscoveredUrl({
            source: "manual",
            sourceKey: request.idempotencyKey,
            url: request.url,
            canonicalUrl,
            metadata: request.metadata,
          }),
        );
        const jobKey = jobKeyForJobId(upserted.job.id);

        sendUrlMediaJob(
          ctx,
          jobKey,
          {
            mode: "db",
            job: toJobSnapshot(upserted.job),
          },
          urlMediaJobRunIdempotencyKey(jobKey, upserted.job),
        );

        return {
          accepted: true,
          jobKey,
          jobId: upserted.job.id,
          sourceId: upserted.sourceId,
        };
      },

      drainPending: async (
        ctx: restate.Context,
        input: unknown,
      ): Promise<DrainResult> => {
        const request = DrainPendingRequest.parse(input ?? {});
        const db = requireDatabase(deps);
        const summary = await ctx.run("summarize-pending-jobs", () =>
          db.summarizePending(request.source, request.statuses),
        );
        const jobs = await ctx.run("list-pending-jobs", () =>
          db.listPending(request.limit, request.source, request.statuses),
        );
        const jobKeys: string[] = [];
        for (const job of jobs) {
          const jobKey = jobKeyForJobId(job.id);
          sendUrlMediaJob(
            ctx,
            jobKey,
            {
              mode: "db",
              job: toJobSnapshot(job),
            },
            urlMediaJobRunIdempotencyKey(jobKey, job),
          );
          jobKeys.push(jobKey);
        }
        return {
          ...summary,
          accepted: jobKeys.length,
          skipped: Math.max(0, summary.due - jobKeys.length),
          jobKeys,
        };
      },

      status: async (
        ctx: restate.Context,
        input: unknown,
      ): Promise<
        WorkerStatus | ArchiveJobDetails | UrlMediaJobState | null
      > => {
        if (input === undefined || input === null) {
          return workerStatus(ctx);
        }
        const request = StatusRequest.parse(input);
        if (request.jobId) {
          const db = requireDatabase(deps);
          return await ctx.run("get-status-by-job-id", () =>
            db.getArchiveJobDetails(request.jobId!),
          );
        }
        if (request.jobKey) {
          const jobId = jobIdFromJobKey(request.jobKey);
          if (jobId) {
            const db = requireDatabase(deps);
            return await ctx.run("get-status-by-pg-job-key", () =>
              db.getArchiveJobDetails(jobId),
            );
          }
          return await ctx.genericCall<undefined, UrlMediaJobState | null>({
            service: URL_MEDIA_JOB_SERVICE,
            method: "status",
            key: request.jobKey,
            parameter: undefined,
            inputSerde: restate.serde.json,
            outputSerde: restate.serde.json,
          });
        }
        if (request.url) {
          const db = requireDatabase(deps);
          const canonicalUrl = canonicalizeUrl(request.url);
          return await ctx.run("get-status-by-canonical-url", () =>
            db.getArchiveJobDetailsByCanonicalUrl(canonicalUrl),
          );
        }
        return null;
      },

      statusBySource: async (
        ctx: restate.Context,
        input: unknown,
      ): Promise<ArchiveJobDetails | null> => {
        const request = StatusBySourceRequest.parse(input);
        const db = requireDatabase(deps);
        return await ctx.run("get-status-by-source", () =>
          db.getStatusDetailsBySource(request.source, request.sourceKey),
        );
      },
    },
  });
}

export function createUrlMediaJob(deps: UrlMediaArchiveDeps = {}) {
  return restate.object({
    name: URL_MEDIA_JOB_SERVICE,
    handlers: {
      run: async (
        ctx: restate.ObjectContext,
        input: unknown,
      ): Promise<UrlMediaJobState> => {
        const request = UrlMediaJobRunRequest.parse(input);
        const existing = await ctx.get<UrlMediaJobState>("state");
        if (existing && COMPLETED_OR_TERMINAL.has(existing.status)) {
          return existing;
        }

        const db = requireDatabase(deps);
        const current = await ctx.run("get-current-job", () =>
          db.getArchiveJob(request.job.id),
        );
        if (!current) {
          throw new restate.TerminalError(
            `Archive job not found: ${request.job.id}`,
            { errorCode: 404 },
          );
        }
        if (COMPLETED_OR_TERMINAL.has(current.status)) {
          const terminalState = await stateFromJob(ctx, current);
          ctx.set("state", terminalState);
          return terminalState;
        }

        const probing =
          (await ctx.run("mark-job-probing", () =>
            db.markProbing(current.id),
          )) ?? current;
        const probed = await probeDbJob(ctx, deps, db, probing);
        ctx.set("state", probed);
        return probed;
      },

      status: restate.handlers.object.shared(
        async (
          ctx: restate.ObjectSharedContext,
        ): Promise<UrlMediaJobState | null> => {
          return await ctx.get<UrlMediaJobState>("state");
        },
      ),
    },
  });
}

export function createUrlMediaRateLimit() {
  return restate.object({
    name: URL_MEDIA_RATE_LIMIT_SERVICE,
    handlers: {
      reserve: async (
        ctx: restate.ObjectContext,
        input: unknown,
      ): Promise<RateLimitReservation> => {
        const request = RateLimitReserveRequest.parse(input ?? {});
        const now = await ctx.date.now();
        const state = (await ctx.get<{ nextAvailableAtMs: number }>(
          "state",
        )) ?? { nextAvailableAtMs: now };
        const reservedAtMs = Math.max(now, state.nextAvailableAtMs);
        const nextAvailableAtMs = reservedAtMs + request.minIntervalMs;
        ctx.set("state", { nextAvailableAtMs });
        return {
          delayMs: Math.max(0, reservedAtMs - now),
          reservedAt: new Date(reservedAtMs).toISOString(),
          nextAvailableAt: new Date(nextAvailableAtMs).toISOString(),
        };
      },
    },
  });
}

export const urlMediaArchive = createUrlMediaArchive();
export const urlMediaJob = createUrlMediaJob();
export const urlMediaRateLimit = createUrlMediaRateLimit();

export type UrlMediaArchive = ReturnType<typeof createUrlMediaArchive>;
export type UrlMediaJob = ReturnType<typeof createUrlMediaJob>;
export type UrlMediaRateLimit = ReturnType<typeof createUrlMediaRateLimit>;

function requireDatabase(deps: UrlMediaArchiveDeps): ArchiveStore {
  if (!deps.db) {
    throw new restate.TerminalError(
      "URL media archive database is not configured",
      {
        errorCode: 500,
      },
    );
  }
  return deps.db;
}

function sendUrlMediaJob(
  ctx: restate.Context,
  jobKey: string,
  request: unknown,
  idempotencyKey = jobKey,
): void {
  ctx.genericSend({
    service: URL_MEDIA_JOB_SERVICE,
    method: RUN_METHOD,
    key: jobKey,
    parameter: request,
    inputSerde: restate.serde.json,
    idempotencyKey,
  });
}

function urlMediaJobRunIdempotencyKey(jobKey: string, job: ArchiveJob): string {
  return `${jobKey}:attempt-${job.attempts}`;
}

function toJobSnapshot(job: ArchiveJob): ArchiveJobSnapshot {
  return {
    id: job.id,
    url: job.url,
    canonicalUrl: job.canonicalUrl,
    status: job.status,
    probeStatus: job.probeStatus,
    attempts: job.attempts,
  };
}

async function workerStatus(ctx: restate.Context): Promise<WorkerStatus> {
  return {
    status: "ok",
    worker: "url-media-archive",
    version: WORKER_VERSION,
    observedAt: await ctx.date.toJSON(),
  };
}

async function stateFromJob(
  ctx: restate.ObjectContext,
  job: ArchiveJob,
): Promise<UrlMediaJobState> {
  return {
    jobKey: ctx.key,
    mode: "db",
    jobId: job.id,
    url: job.url,
    canonicalUrl: job.canonicalUrl,
    status: job.status,
    updatedAt: await ctx.date.toJSON(),
    nextRetryAt: job.nextRetryAt,
  };
}

async function probeDbJob(
  ctx: restate.ObjectContext,
  deps: UrlMediaArchiveDeps,
  db: ArchiveStore,
  job: ArchiveJob,
): Promise<UrlMediaJobState> {
  const prober = deps.prober;
  if (!prober) {
    return await stateFromJob(ctx, job);
  }

  await waitForYtDlpRateLimitSlot(ctx, deps, job.url, "probe");
  const probe = await ctx.run("probe-media", () => prober.probe(job.url));
  const updated = await persistProbeResult(ctx, db, job, probe);
  const probeState = await stateFromJobAndProbe(ctx, updated ?? job, probe);
  if (!probe.hasMedia) return probeState;

  const archive = await archiveDownloadedMedia(ctx, deps, {
    mode: "db",
    url: job.url,
    canonicalUrl: job.canonicalUrl,
    metadata: probe.metadata,
  });
  if (!archive) return probeState;
  if (archive.failure) {
    const failed = await persistArchiveFailure(ctx, db, job, archive.failure);
    await cleanupFailureTempDirIfNeeded(ctx, deps);
    await cleanupFinalDirIfStoreFailed(ctx, deps, archive);
    return {
      ...(await stateFromJobAndProbe(ctx, failed ?? job, probe)),
      probeError: archive.failure.error,
    };
  }
  if (archive.outputs.length === 0) {
    const retryAt = await nextRetryAt(
      ctx,
      { kind: "unknown_retryable", retryable: true },
      job.attempts,
    );
    const failed = await ctx.run("mark-job-failed", () =>
      db.markFailed(
        job.id,
        {
          type: "download_empty",
          message: "yt-dlp completed without downloaded media files",
          retryable: true,
          terminal: false,
        },
        retryAt,
      ),
    );
    await cleanupFailureTempDirIfNeeded(ctx, deps);
    return await stateFromJobAndProbe(ctx, failed ?? job, probe);
  }

  const stored = await ctx.run("mark-job-stored", () =>
    db.markStored(job.id, archive.outputs),
  );
  await cleanupTempDirBestEffort(ctx, deps);
  return {
    ...(await stateFromJobAndProbe(ctx, stored ?? job, probe)),
    outputs: archive.outputs,
  };
}

async function waitForYtDlpRateLimitSlot(
  ctx: restate.ObjectContext,
  deps: UrlMediaArchiveDeps,
  url: string,
  phase: "probe" | "download",
): Promise<void> {
  const minIntervalMs = deps.ytDlpRequestMinIntervalMs ?? 0;
  if (minIntervalMs <= 0) return;

  const bucket = rateLimitBucketForUrl(url);
  const reservation = await ctx.genericCall<unknown, RateLimitReservation>({
    service: URL_MEDIA_RATE_LIMIT_SERVICE,
    method: "reserve",
    key: bucket,
    parameter: { minIntervalMs },
    inputSerde: restate.serde.json,
    outputSerde: restate.serde.json,
  });

  if (reservation.delayMs > 0) {
    await ctx.sleep(reservation.delayMs, `yt-dlp-rate-limit-${phase}`);
  }
}

function rateLimitBucketForUrl(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

async function archiveDownloadedMedia(
  ctx: restate.ObjectContext,
  deps: UrlMediaArchiveDeps,
  input: {
    mode: "db" | "url";
    url: string;
    canonicalUrl: string;
    metadata: Record<string, unknown>;
  },
): Promise<ArchiveMediaResult | null> {
  const downloader = deps.downloader;
  const sink = deps.sink;
  const archiveRoot = deps.archiveRoot;
  if (!downloader || !sink || !archiveRoot) return null;

  await waitForYtDlpRateLimitSlot(ctx, deps, input.url, "download");
  const targetDir = downloadTempDir(archiveRoot, ctx.key);
  const download = await ctx.run("download-media", async () => {
    try {
      return {
        ok: true as const,
        result: await downloader.download(input.url, targetDir),
      };
    } catch (error) {
      return {
        ok: false as const,
        failure: classifyArchiveError("download", error),
      };
    }
  });
  if (!download.ok) return { failure: download.failure };

  const observedAt = await ctx.date.toJSON();
  const stored = await ctx.run("store-filesystem-outputs", async () => {
    try {
      return {
        ok: true as const,
        outputs: await sink.store({
          archiveRoot,
          jobKey: ctx.key,
          mode: input.mode,
          canonicalUrl: input.canonicalUrl,
          downloadedFiles: download.result.files,
          metadata: input.metadata,
          observedAt,
        }),
      };
    } catch (error) {
      return {
        ok: false as const,
        failure: classifyArchiveError("store", error),
      };
    }
  });
  if (!stored.ok) {
    return { failure: stored.failure, finalDirObservedAt: observedAt };
  }
  return { outputs: stored.outputs };
}

async function cleanupFailureTempDirIfNeeded(
  ctx: restate.ObjectContext,
  deps: UrlMediaArchiveDeps,
): Promise<void> {
  if (deps.keepFailedTempDirs) return;
  await cleanupTempDirBestEffort(ctx, deps);
}

async function cleanupFinalDirIfStoreFailed(
  ctx: restate.ObjectContext,
  deps: UrlMediaArchiveDeps,
  archive: Extract<ArchiveMediaResult, { failure: ArchiveFailure }>,
): Promise<void> {
  if (archive.failure.phase !== "store" || !archive.finalDirObservedAt) return;
  await cleanupFinalDirBestEffort(ctx, deps, archive.finalDirObservedAt);
}

async function cleanupFinalDirBestEffort(
  ctx: restate.ObjectContext,
  deps: UrlMediaArchiveDeps,
  observedAt: string,
): Promise<void> {
  const cleaner = deps.cleanupFinalDir;
  const archiveRoot = deps.archiveRoot;
  if (!cleaner || !archiveRoot) return;

  await ctx.run("cleanup-final-dir", async () => {
    try {
      await cleaner.cleanup(archiveRoot, ctx.key, observedAt);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  });
}

async function cleanupTempDirBestEffort(
  ctx: restate.ObjectContext,
  deps: UrlMediaArchiveDeps,
): Promise<void> {
  const cleaner = deps.cleanupTempDir;
  const archiveRoot = deps.archiveRoot;
  if (!cleaner || !archiveRoot) return;

  await ctx.run("cleanup-temp-dir", async () => {
    try {
      await cleaner.cleanup(archiveRoot, ctx.key);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
  });
}

async function persistArchiveFailure(
  ctx: restate.ObjectContext,
  db: ArchiveStore,
  job: ArchiveJob,
  failure: ArchiveFailure,
): Promise<ArchiveJob | null> {
  if (failure.terminal) {
    return await ctx.run("mark-job-terminal-failed", () =>
      db.markTerminalFailed(job.id, failure.error),
    );
  }
  const retryAt = await nextRetryAt(ctx, failure, job.attempts);
  return await ctx.run("mark-job-failed", () =>
    db.markFailed(job.id, failure.error, retryAt),
  );
}

async function persistProbeResult(
  ctx: restate.ObjectContext,
  db: ArchiveStore,
  job: ArchiveJob,
  probe: YtDlpProbeResult,
): Promise<ArchiveJob | null> {
  if (probe.hasMedia) {
    return await ctx.run("mark-job-downloading", () =>
      db.markDownloading(job.id, probe.metadata),
    );
  }

  const error = probe.error ? compactRecord(probe.error) : {};
  if (probe.probeStatus === "no_media") {
    return await ctx.run("mark-job-no-media", () =>
      db.markNoMedia(job.id, error),
    );
  }

  if (probe.terminal) {
    return await ctx.run("mark-job-terminal-failed", () =>
      db.markTerminalFailed(job.id, {
        ...error,
        retryable: false,
        terminal: true,
      }),
    );
  }

  const retryAt = await nextRetryAt(
    ctx,
    {
      kind: archiveFailureKindFromProbe(probe),
      retryable: true,
    },
    job.attempts,
  );
  return await ctx.run("mark-job-failed", () =>
    db.markFailed(
      job.id,
      {
        ...error,
        retryable: true,
        terminal: false,
      },
      retryAt,
      probe.probeStatus,
    ),
  );
}

async function stateFromJobAndProbe(
  ctx: restate.ObjectContext,
  job: ArchiveJob,
  probe: YtDlpProbeResult,
): Promise<UrlMediaJobState> {
  return {
    jobKey: ctx.key,
    mode: "db",
    jobId: job.id,
    url: job.url,
    canonicalUrl: job.canonicalUrl,
    status: job.status,
    updatedAt: await ctx.date.toJSON(),
    probeStatus: probe.probeStatus,
    probeError: probe.error ? compactRecord(probe.error) : undefined,
    nextRetryAt: job.nextRetryAt,
  };
}

async function nextRetryAt(
  ctx: restate.ObjectContext,
  failure: Pick<ArchiveFailure, "kind" | "retryable">,
  attempts: number,
): Promise<string | null> {
  return calculateNextRetryAt(failure, attempts, await ctx.date.toJSON());
}

function archiveFailureKindFromProbe(
  probe: YtDlpProbeResult,
): ArchiveFailureKind {
  if (probe.error?.type === "retryable_network_timeout") {
    return "retryable_network_timeout";
  }
  if (probe.error?.type === "retryable_rate_limit") {
    return "retryable_rate_limit";
  }
  if (probe.error?.type === "retryable_remote_5xx") {
    return "retryable_remote_5xx";
  }
  return "unknown_retryable";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compactRecord(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}
