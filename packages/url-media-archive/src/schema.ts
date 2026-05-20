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

export const HostQueueDrainRequest = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(25),
    jobId: Uuid.optional(),
    source: SourceName.optional(),
    statuses: z
      .array(z.enum(["pending", "failed"]))
      .min(1)
      .max(2)
      .default(["pending", "failed"]),
  })
  .strict();
export type HostQueueDrainRequest = z.infer<typeof HostQueueDrainRequest>;

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

export const UrlMediaJobRunRequest = z
  .object({
    mode: z.literal("db"),
    job: ArchiveJobSnapshot,
  })
  .strict();
export type UrlMediaJobRunRequest = z.infer<typeof UrlMediaJobRunRequest>;

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

export const RateLimitReservation = z.object({
  delayMs: z.number().int().nonnegative(),
  intervalMs: z.number().int().nonnegative(),
  jitterMs: z.number().int().nonnegative(),
  reservedAt: z.string(),
  nextAvailableAt: z.string(),
});
export type RateLimitReservation = z.infer<typeof RateLimitReservation>;

export const WorkerStatus = z.object({
  status: z.literal("ok"),
  worker: z.literal("url-media-archive"),
  version: z.string(),
  observedAt: z.string(),
});
export type WorkerStatus = z.infer<typeof WorkerStatus>;
