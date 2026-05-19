import { readFileSync } from "fs";

export type RuntimeConfig = {
  host: string;
  port: number;
  archiveRoot: string;
  cookiePath?: string;
  databaseUrl?: string;
  restateIdentityKeys: string[];
  ytDlpBinary: string;
  ytDlpProbeTimeoutMs: number;
  ytDlpDownloadTimeoutMs: number;
  ytDlpProbeConcurrency: number;
  ytDlpDownloadConcurrency: number;
  ytDlpRequestMinIntervalMs: number;
  keepFailedTempDirs: boolean;
};

export type RuntimeEnv = Record<string, string | undefined>;

export function readRuntimeConfig(
  env: RuntimeEnv = process.env,
): RuntimeConfig {
  return {
    host: nonEmpty(env.URL_MEDIA_ARCHIVE_HOST) ?? "127.0.0.1",
    port: parsePort(env.URL_MEDIA_ARCHIVE_PORT ?? env.PORT, 9080),
    archiveRoot:
      env.URL_MEDIA_ARCHIVE_ROOT?.trim() ||
      "/var/lib/url-media-archive/archive",
    cookiePath: readCookiePath(env),
    databaseUrl: readDatabaseUrl(env),
    restateIdentityKeys: parseIdentityKeys(
      env.URL_MEDIA_ARCHIVE_RESTATE_IDENTITY_KEYS,
    ),
    ytDlpBinary: nonEmpty(env.URL_MEDIA_ARCHIVE_YTDLP_BINARY) ?? "yt-dlp",
    ytDlpProbeTimeoutMs: parsePositiveInteger(
      env.URL_MEDIA_ARCHIVE_YTDLP_PROBE_TIMEOUT_MS,
      120_000,
    ),
    ytDlpDownloadTimeoutMs: parsePositiveInteger(
      env.URL_MEDIA_ARCHIVE_YTDLP_DOWNLOAD_TIMEOUT_MS,
      900_000,
    ),
    ytDlpProbeConcurrency: parsePositiveInteger(
      env.URL_MEDIA_ARCHIVE_YTDLP_PROBE_CONCURRENCY,
      2,
    ),
    ytDlpDownloadConcurrency: parsePositiveInteger(
      env.URL_MEDIA_ARCHIVE_YTDLP_DOWNLOAD_CONCURRENCY,
      2,
    ),
    ytDlpRequestMinIntervalMs: parseNonNegativeInteger(
      env.URL_MEDIA_ARCHIVE_YTDLP_REQUEST_MIN_INTERVAL_MS,
      0,
    ),
    keepFailedTempDirs: parseBoolean(
      env.URL_MEDIA_ARCHIVE_KEEP_FAILED_TEMP_DIRS,
      false,
    ),
  };
}

function readDatabaseUrl(env: RuntimeEnv): string | undefined {
  const inline = nonEmpty(env.URL_MEDIA_ARCHIVE_DATABASE_URL);
  if (inline) return inline;

  const file = nonEmpty(env.URL_MEDIA_ARCHIVE_DATABASE_URL_FILE);
  if (!file) return undefined;
  return readFileSync(file, "utf8").trim();
}

function readCookiePath(env: RuntimeEnv): string | undefined {
  return (
    nonEmpty(env.URL_MEDIA_ARCHIVE_COOKIE_PATH) ??
    nonEmpty(env.URL_MEDIA_ARCHIVE_COOKIE_FILE)
  );
}

function parseIdentityKeys(value: string | undefined): string[] {
  const raw = nonEmpty(value);
  if (!raw) return [];

  return raw
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = parsePositiveInteger(value, fallback);
  if (parsed > 65535) {
    throw new Error(`Invalid TCP port: ${value?.trim()}`);
  }
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const raw = value?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`Invalid boolean: ${raw}`);
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = parseNonNegativeInteger(value, fallback);
  if (parsed <= 0) {
    throw new Error(`Invalid positive integer: ${value?.trim()}`);
  }
  return parsed;
}

function parseNonNegativeInteger(
  value: string | undefined,
  fallback: number,
): number {
  const raw = value?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid non-negative integer: ${raw}`);
  }
  return parsed;
}
