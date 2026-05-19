import { CommandError } from "./childProcess";

export type ArchiveFailurePhase = "probe" | "download" | "store";

export type ArchiveFailureKind =
  | "retryable_network_timeout"
  | "retryable_rate_limit"
  | "retryable_remote_5xx"
  | "terminal_auth_cookie_invalid"
  | "terminal_private_or_deleted"
  | "terminal_unsupported_url"
  | "terminal_filesystem_permission"
  | "terminal_filesystem_path"
  | "unknown_retryable";

export type ArchiveFailure = {
  kind: ArchiveFailureKind;
  phase: ArchiveFailurePhase;
  message: string;
  terminal: boolean;
  retryable: boolean;
  error: Record<string, unknown>;
};

export function classifyArchiveError(
  phase: ArchiveFailurePhase,
  error: unknown,
): ArchiveFailure {
  const message = errorMessage(error);
  const lower = message.toLowerCase();
  const nodeCode = nodeErrorCode(error);

  if (error instanceof CommandError && error.result.timedOut) {
    return failure("retryable_network_timeout", phase, message, error, true);
  }
  if (/(rate limit|too many requests|\b429\b)/i.test(lower)) {
    return failure("retryable_rate_limit", phase, message, error, true);
  }
  if (isFilesystemPathFailure(nodeCode, lower)) {
    return failure("terminal_filesystem_path", phase, message, error, false);
  }
  if (
    /(http error 5\d\d|http status 5\d\d|server error|bad gateway|service unavailable)/i.test(
      lower,
    )
  ) {
    return failure("retryable_remote_5xx", phase, message, error, true);
  }
  if (/(timeout|timed out|econnreset|enotfound|network)/i.test(lower)) {
    return failure("retryable_network_timeout", phase, message, error, true);
  }
  if (
    /(login|sign in|cookie|unauthorized|forbidden|authentication)/i.test(lower)
  ) {
    return failure(
      "terminal_auth_cookie_invalid",
      phase,
      message,
      error,
      false,
    );
  }
  if (
    /(private|deleted|removed|not available|unavailable|blocked|copyright)/i.test(
      lower,
    )
  ) {
    return failure("terminal_private_or_deleted", phase, message, error, false);
  }
  if (
    /(unsupported url|no video formats|no formats found|does not contain|no media|not a video)/i.test(
      lower,
    )
  ) {
    return failure("terminal_unsupported_url", phase, message, error, false);
  }
  if (nodeCode && ["EACCES", "EPERM", "EROFS"].includes(nodeCode)) {
    return failure(
      "terminal_filesystem_permission",
      phase,
      message,
      error,
      false,
    );
  }
  return failure("unknown_retryable", phase, message, error, true);
}

function isFilesystemPathFailure(
  nodeCode: string | undefined,
  lowerMessage: string,
): boolean {
  return (
    (nodeCode !== undefined &&
      [
        "ENOENT",
        "ENOTDIR",
        "EISDIR",
        "ENAMETOOLONG",
        "ENOTEMPTY",
        "EEXIST",
      ].includes(nodeCode)) ||
    /file name too long|not a directory|is a directory/i.test(lowerMessage)
  );
}

export function calculateNextRetryAt(
  failure: Pick<ArchiveFailure, "kind" | "retryable">,
  attempts: number,
  observedAt: string,
): string | null {
  if (!failure.retryable) return null;
  const observed = new Date(observedAt);
  if (Number.isNaN(observed.getTime())) {
    throw new Error(`Invalid observedAt timestamp: ${observedAt}`);
  }
  return new Date(
    observed.getTime() + retryDelayMs(failure.kind, attempts),
  ).toISOString();
}

function retryDelayMs(kind: ArchiveFailureKind, attempts: number): number {
  const attemptIndex = Math.max(0, attempts - 1);
  const schedule =
    kind === "retryable_rate_limit"
      ? [30, 120, 720, 1440]
      : [5, 30, 120, 720, 1440];
  const minutes = schedule[Math.min(attemptIndex, schedule.length - 1)];
  return minutes * 60 * 1000;
}

function failure(
  kind: ArchiveFailureKind,
  phase: ArchiveFailurePhase,
  message: string,
  error: unknown,
  retryable: boolean,
): ArchiveFailure {
  return {
    kind,
    phase,
    message,
    terminal: !retryable,
    retryable,
    error: compactRecord({
      type: kind,
      phase,
      message,
      retryable,
      terminal: !retryable,
      ...commandErrorFields(error),
      code: nodeErrorCode(error),
    }),
  };
}

function commandErrorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof CommandError)) return {};
  return {
    command: error.result.command,
    exitCode: error.result.exitCode,
    signal: error.result.signal,
    timedOut: error.result.timedOut,
    stderr: truncate(error.result.stderr),
    stdout: truncate(error.result.stdout),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof CommandError) {
    return [error.message, error.result.stderr, error.result.stdout]
      .filter(Boolean)
      .join("\n");
  }
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown archive failure";
}

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function truncate(value: string): string | undefined {
  if (!value) return undefined;
  return value.length > 4096 ? `${value.slice(0, 4096)}…` : value;
}

function compactRecord(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}
