import { z } from "zod";

const NonEmptyString = z.string().trim().min(1);
const SourceName = NonEmptyString.regex(/^[A-Za-z0-9._:-]+$/).max(100);
const Metadata = z.record(z.string(), z.unknown());
const IdempotencyKey = NonEmptyString.max(256);
const Uuid = z.string().uuid();

export const UrlArchiveStatus = z.enum([
  "pending",
  "probing",
  "no_media",
  "downloading",
  "stored",
  "failed",
  "terminal_failed",
  "skipped",
]);
export type UrlArchiveStatus = z.infer<typeof UrlArchiveStatus>;

export const UrlProbeStatus = z.enum([
  "unknown",
  "has_media",
  "no_media",
  "unavailable",
  "auth_required",
]);
export type UrlProbeStatus = z.infer<typeof UrlProbeStatus>;

export const SubmitDiscoveredUrlRequest = z
  .object({
    source: SourceName,
    sourceKey: NonEmptyString.max(512).optional(),
    url: z.url(),
    sourceUrl: z.url().optional(),
    sourceCreatedAt: z.iso.datetime().optional(),
    discoveredAt: z.iso.datetime().optional(),
    metadata: Metadata.optional(),
    idempotencyKey: IdempotencyKey.optional(),
  })
  .strict();
export type SubmitDiscoveredUrlRequest = z.infer<
  typeof SubmitDiscoveredUrlRequest
>;

export const SubmitJobRequest = z
  .object({
    jobId: Uuid,
    idempotencyKey: IdempotencyKey.optional(),
  })
  .strict();
export type SubmitJobRequest = z.infer<typeof SubmitJobRequest>;

export const SubmitUrlRequest = z
  .object({
    url: z.url(),
    idempotencyKey: IdempotencyKey.optional(),
    metadata: Metadata.optional(),
    sink: z
      .object({
        type: z.literal("filesystem"),
        root: NonEmptyString.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SubmitUrlRequest = z.infer<typeof SubmitUrlRequest>;

export const DrainPendingRequest = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(25),
    source: SourceName.optional(),
    statuses: z
      .array(z.enum(["pending", "failed"]))
      .min(1)
      .max(2)
      .default(["pending", "failed"]),
  })
  .strict();
export type DrainPendingRequest = z.infer<typeof DrainPendingRequest>;

export const StatusRequest = z
  .object({
    jobId: Uuid.optional(),
    jobKey: NonEmptyString.max(300).optional(),
    url: z.url().optional(),
  })
  .strict()
  .refine((value) => value.jobId || value.jobKey || value.url, {
    message: "jobId, jobKey, or url is required",
  });
export type StatusRequest = z.infer<typeof StatusRequest>;

export const StatusBySourceRequest = z
  .object({
    source: SourceName,
    sourceKey: NonEmptyString.max(512),
  })
  .strict();
export type StatusBySourceRequest = z.infer<typeof StatusBySourceRequest>;

export const GetDiscoveryStateRequest = z
  .object({
    source: SourceName,
  })
  .strict();
export type GetDiscoveryStateRequest = z.infer<typeof GetDiscoveryStateRequest>;

export const StartDiscoveryScanRequest = z
  .object({
    source: SourceName,
    resetCursor: z.boolean().default(false),
  })
  .strict();
export type StartDiscoveryScanRequest = z.infer<
  typeof StartDiscoveryScanRequest
>;

export const DiscoveryPageItem = z
  .object({
    sourceKey: NonEmptyString.max(512),
    url: z.url(),
    sourceUrl: z.url().optional(),
    sourceCreatedAt: z.iso.datetime().optional(),
    discoveredAt: z.iso.datetime().optional(),
    idempotencyKey: IdempotencyKey.optional(),
    metadata: Metadata.optional(),
  })
  .strict();
export type DiscoveryPageItem = z.infer<typeof DiscoveryPageItem>;

export const RecordDiscoveryPageRequest = z
  .object({
    source: SourceName,
    stateVersion: z.number().int().nonnegative().optional(),
    pageSize: z.number().int().min(1).max(100),
    pagesPerRun: z.number().int().min(1).max(100),
    fullCoverage: z.boolean().default(false),
    startedFromCursor: z.boolean().default(false),
    scanStartedAt: z.iso.datetime(),
    paginationToken: z.string().max(2048).default(""),
    nextToken: z.string().max(2048).default(""),
    requestContext: Metadata.optional(),
    items: z.array(DiscoveryPageItem).max(100),
  })
  .strict();
export type RecordDiscoveryPageRequest = z.infer<
  typeof RecordDiscoveryPageRequest
>;

export const ArchiveJobSnapshot = z
  .object({
    id: Uuid,
    url: z.url(),
    canonicalUrl: z.url(),
    status: UrlArchiveStatus,
    probeStatus: UrlProbeStatus,
    attempts: z.number().int().nonnegative(),
  })
  .strict();
export type ArchiveJobSnapshot = z.infer<typeof ArchiveJobSnapshot>;

export const UrlMediaAttemptRunRequest = z
  .object({
    mode: z.literal("db"),
    job: ArchiveJobSnapshot,
  })
  .strict();
export type UrlMediaAttemptRunRequest = z.infer<
  typeof UrlMediaAttemptRunRequest
>;

export const UrlMediaWorkflowRunRequest = z
  .object({
    jobId: Uuid,
    maxAttemptsPerInvocation: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type UrlMediaWorkflowRunRequest = z.infer<
  typeof UrlMediaWorkflowRunRequest
>;

export const WorkerStatus = z.object({
  status: z.literal("ok"),
  worker: z.literal("url-media-archive"),
  version: z.string(),
  observedAt: z.string(),
});
export type WorkerStatus = z.infer<typeof WorkerStatus>;
