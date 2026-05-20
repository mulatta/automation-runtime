import { readdir, stat } from "fs/promises";
import { join } from "path";

import { CommandError, runCommand, type CommandResult } from "./childProcess";
import type { UrlProbeStatus } from "./schema";
import { AsyncSemaphore } from "./semaphore";

export type ProbeError = {
  type:
    | "auth_required"
    | "no_media"
    | "retryable_network_timeout"
    | "retryable_rate_limit"
    | "retryable_remote_5xx"
    | "unavailable"
    | "invalid_output";
  message: string;
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  followedExternal?: boolean;
  inputHost?: string;
  externalHost?: string;
};

export type YtDlpProbeMetadata = {
  id?: string;
  title?: string;
  extractor?: string;
  extractorKey?: string;
  webpageUrl?: string;
  originalUrl?: string;
  duration?: number;
  uploadDate?: string;
  timestamp?: number;
  formatCount?: number;
  inputHost?: string;
  webpageHost?: string;
  originalHost?: string;
  followedExternal?: boolean;
};

export type YtDlpProbeResult = {
  hasMedia: boolean;
  probeStatus: Exclude<UrlProbeStatus, "unknown">;
  terminal: boolean;
  retryable: boolean;
  metadata: YtDlpProbeMetadata;
  error?: ProbeError;
};

export type ProbeRunner = (
  command: string,
  args: readonly string[],
  options?: { timeoutMs?: number },
) => Promise<CommandResult>;

export type YtDlpProbeOptions = {
  binary?: string;
  cookiesFile?: string;
  timeoutMs?: number;
  runCommand?: ProbeRunner;
};

export type YtDlpDownloadOptions = YtDlpProbeOptions & {
  targetDir: string;
};

export type YtDlpClientOptions = Omit<YtDlpProbeOptions, "timeoutMs"> & {
  probeTimeoutMs?: number;
  downloadTimeoutMs?: number;
  probeConcurrency?: number;
  downloadConcurrency?: number;
};

export type YtDlpDownloadResult = {
  files: string[];
};

const DEFAULT_YTDLP_BINARY = "yt-dlp";
const DEFAULT_PROBE_TIMEOUT_MS = 120_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 900_000;
const DEFAULT_PROBE_CONCURRENCY = 2;
const DEFAULT_DOWNLOAD_CONCURRENCY = 2;
const DOWNLOAD_OUTPUT_TEMPLATE = "%(id)s.%(ext)s";

export async function probeWithYtDlp(
  url: string,
  options: YtDlpProbeOptions = {},
): Promise<YtDlpProbeResult> {
  const command = options.binary ?? DEFAULT_YTDLP_BINARY;
  const args = buildProbeArgs(url, options.cookiesFile);
  const runner = options.runCommand ?? runCommand;

  try {
    const result = await runner(command, args, {
      timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    });
    return probeResultFromStdout(result.stdout, url);
  } catch (error) {
    if (error instanceof CommandError) {
      return classifyFailure(error.result);
    }
    throw error;
  }
}

export async function downloadWithYtDlp(
  url: string,
  options: YtDlpDownloadOptions,
): Promise<YtDlpDownloadResult> {
  const command = options.binary ?? DEFAULT_YTDLP_BINARY;
  const args = buildDownloadArgs(url, options.targetDir, options.cookiesFile);
  const runner = options.runCommand ?? runCommand;
  await runner(command, args, {
    timeoutMs: options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
  });
  return { files: await listDownloadedMediaFiles(options.targetDir) };
}

export function createYtDlpClient(options: YtDlpClientOptions = {}) {
  const {
    probeTimeoutMs,
    downloadTimeoutMs,
    probeConcurrency,
    downloadConcurrency,
    ...commandOptions
  } = options;
  const probeLimiter = new AsyncSemaphore(
    probeConcurrency ?? DEFAULT_PROBE_CONCURRENCY,
  );
  const downloadLimiter = new AsyncSemaphore(
    downloadConcurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY,
  );

  return {
    probe: (url: string) =>
      probeLimiter.runExclusive(() =>
        probeWithYtDlp(url, { ...commandOptions, timeoutMs: probeTimeoutMs }),
      ),
    download: (url: string, targetDir: string) =>
      downloadLimiter.runExclusive(() =>
        downloadWithYtDlp(url, {
          ...commandOptions,
          targetDir,
          timeoutMs: downloadTimeoutMs,
        }),
      ),
  };
}

export const createYtDlpProber = createYtDlpClient;

function buildProbeArgs(
  url: string,
  cookiesFile: string | undefined,
): string[] {
  const args = ["--dump-single-json", "--no-playlist", "--skip-download"];
  if (cookiesFile) {
    args.push("--cookies", cookiesFile);
  }
  args.push(url);
  return args;
}

function buildDownloadArgs(
  url: string,
  targetDir: string,
  cookiesFile: string | undefined,
): string[] {
  const args = [
    "--no-playlist",
    "--paths",
    targetDir,
    "--output",
    DOWNLOAD_OUTPUT_TEMPLATE,
    "--write-info-json",
  ];
  if (cookiesFile) {
    args.push("--cookies", cookiesFile);
  }
  args.push(url);
  return args;
}

async function listDownloadedMediaFiles(targetDir: string): Promise<string[]> {
  const entries = await readdir(targetDir);
  const files: string[] = [];
  for (const entry of entries.sort()) {
    if (entry.endsWith(".info.json") || entry.endsWith(".part")) continue;
    const path = join(targetDir, entry);
    const entryStat = await stat(path);
    if (entryStat.isFile()) files.push(path);
  }
  return files;
}

function probeResultFromStdout(
  stdout: string,
  inputUrl: string,
): YtDlpProbeResult {
  const parsed = parseJsonObject(stdout);
  const metadata = extractMetadata(parsed, inputUrl);
  const hasMedia = hasExtractableMedia(parsed);

  if (hasMedia && !metadata.followedExternal) {
    return {
      hasMedia: true,
      probeStatus: "has_media",
      terminal: false,
      retryable: false,
      metadata,
    };
  }

  return {
    hasMedia: false,
    probeStatus: "no_media",
    terminal: true,
    retryable: false,
    metadata,
    error: noMediaError(metadata),
  };
}

function noMediaError(metadata: YtDlpProbeMetadata): ProbeError {
  if (metadata.followedExternal) {
    return compactError({
      type: "no_media",
      message: "yt-dlp resolved media on an external host",
      timedOut: false,
      followedExternal: true,
      inputHost: metadata.inputHost,
      externalHost: metadata.webpageHost ?? metadata.originalHost,
    });
  }

  return {
    type: "no_media",
    message: "yt-dlp returned metadata without downloadable formats",
    timedOut: false,
  };
}

function parseJsonObject(stdout: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stdout);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CommandError({
      command: "yt-dlp",
      args: [],
      exitCode: 0,
      signal: null,
      stdout,
      stderr: "yt-dlp returned non-object JSON",
      timedOut: false,
    });
  }
  return parsed as Record<string, unknown>;
}

function hasExtractableMedia(info: Record<string, unknown>): boolean {
  return nonEmptyArray(info.formats) || nonEmptyArray(info.requested_downloads);
}

function extractMetadata(
  info: Record<string, unknown>,
  inputUrl: string,
): YtDlpProbeMetadata {
  const webpageUrl = stringValue(info.webpage_url);
  const originalUrl = stringValue(info.original_url);
  const inputHost = hostFromUrl(inputUrl);
  const webpageHost = hostFromUrl(webpageUrl);
  const originalHost = hostFromUrl(originalUrl);
  const resolvedHost = webpageHost ?? originalHost;
  const followedExternal =
    inputHost !== undefined &&
    resolvedHost !== undefined &&
    !sameHost(inputHost, resolvedHost);

  return compactMetadata({
    id: stringValue(info.id),
    title: stringValue(info.title),
    extractor: stringValue(info.extractor),
    extractorKey: stringValue(info.extractor_key),
    webpageUrl,
    originalUrl,
    duration: numberValue(info.duration),
    uploadDate: stringValue(info.upload_date),
    timestamp: numberValue(info.timestamp),
    formatCount: Array.isArray(info.formats) ? info.formats.length : undefined,
    inputHost,
    webpageHost,
    originalHost,
    followedExternal,
  });
}

function classifyFailure(result: CommandResult): YtDlpProbeResult {
  const message = [result.stderr, result.stdout].filter(Boolean).join("\n");
  const lower = message.toLowerCase();

  if (result.timedOut) {
    return failureResult(
      "retryable_network_timeout",
      "unavailable",
      true,
      false,
      result,
      message,
    );
  }
  if (/(rate limit|rate-limit|too many requests|\b429\b)/i.test(lower)) {
    return failureResult(
      "retryable_rate_limit",
      "unavailable",
      true,
      false,
      result,
      message,
    );
  }
  const externalUrl = followedExternalUrl(result);
  if (externalUrl) {
    return failureResult(
      "no_media",
      "no_media",
      false,
      true,
      result,
      message,
      externalProbeErrorFields(result, externalUrl),
    );
  }
  if (
    /(\b5\d\d\b|http error 5\d\d|server error|bad gateway|service unavailable)/i.test(
      lower,
    )
  ) {
    return failureResult(
      "retryable_remote_5xx",
      "unavailable",
      true,
      false,
      result,
      message,
    );
  }
  if (
    /(login|sign in|cookie|private|members-only|authentication)/i.test(lower)
  ) {
    return failureResult(
      "auth_required",
      "auth_required",
      false,
      true,
      result,
      message,
    );
  }
  if (
    /(unsupported url|no video (?:could be )?found|no video formats|no formats found|does not contain|no media|not a video)/i.test(
      lower,
    )
  ) {
    return failureResult("no_media", "no_media", false, true, result, message);
  }
  if (/(connection reset|econnreset|enotfound|network)/i.test(lower)) {
    return failureResult(
      "retryable_network_timeout",
      "unavailable",
      true,
      false,
      result,
      message,
    );
  }
  if (
    /(unavailable|not available|deleted|removed|blocked|copyright|suspended)/i.test(
      lower,
    )
  ) {
    return failureResult(
      "unavailable",
      "unavailable",
      false,
      true,
      result,
      message,
    );
  }

  return failureResult(
    "unavailable",
    "unavailable",
    true,
    false,
    result,
    message,
  );
}

function failureResult(
  type: ProbeError["type"],
  probeStatus: Exclude<UrlProbeStatus, "unknown">,
  retryable: boolean,
  terminal: boolean,
  result: CommandResult,
  message: string,
  extraErrorFields: Partial<ProbeError> = {},
): YtDlpProbeResult {
  return {
    hasMedia: false,
    probeStatus,
    retryable,
    terminal,
    metadata: {},
    error: compactError({
      type,
      message: message || `${result.command} failed`,
      exitCode: result.exitCode ?? undefined,
      signal: result.signal ?? undefined,
      timedOut: result.timedOut,
      ...extraErrorFields,
    }),
  };
}

function nonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function followedExternalUrl(result: CommandResult): string | undefined {
  const inputUrl = result.args.at(-1);
  const inputHost = hostFromUrl(inputUrl);
  if (!inputHost) return undefined;

  const extractedUrls = [result.stderr, result.stdout]
    .join("\n")
    .matchAll(/Extracting URL:\s*(https?:\/\/\S+)/gi);
  for (const match of extractedUrls) {
    const candidate = match[1];
    const candidateHost = hostFromUrl(candidate);
    if (candidateHost && !sameHost(inputHost, candidateHost)) {
      return candidate;
    }
  }
  return undefined;
}

function externalProbeErrorFields(
  result: CommandResult,
  externalUrl: string,
): Partial<ProbeError> {
  return {
    followedExternal: true,
    inputHost: hostFromUrl(result.args.at(-1)),
    externalHost: hostFromUrl(externalUrl),
  };
}

function hostFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function sameHost(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function compactMetadata(metadata: YtDlpProbeMetadata): YtDlpProbeMetadata {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );
}

function compactError(error: ProbeError): ProbeError {
  return Object.fromEntries(
    Object.entries(error).filter(([, value]) => value !== undefined),
  ) as ProbeError;
}
