import { CommandError, type CommandResult } from "../src/childProcess";
import { calculateNextRetryAt, classifyArchiveError } from "../src/errors";

function commandResult(overrides: Partial<CommandResult>): CommandResult {
  return {
    command: "yt-dlp",
    args: [],
    exitCode: 1,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...overrides,
  };
}

describe("classifyArchiveError", () => {
  it("classifies yt-dlp timeouts as retryable", () => {
    const failure = classifyArchiveError(
      "download",
      new CommandError(
        commandResult({ timedOut: true, stderr: "timed out after 5ms" }),
      ),
    );

    expect(failure).toMatchObject({
      kind: "retryable_network_timeout",
      terminal: false,
      retryable: true,
      phase: "download",
    });
  });

  it("classifies rate limits with longer retry backoff", () => {
    const failure = classifyArchiveError(
      "download",
      new CommandError(commandResult({ stderr: "ERROR: HTTP Error 429" })),
    );

    expect(failure).toMatchObject({
      kind: "retryable_rate_limit",
      terminal: false,
      retryable: true,
    });
    expect(calculateNextRetryAt(failure, 1, "2026-05-18T00:00:00.000Z")).toBe(
      "2026-05-18T00:30:00.000Z",
    );
  });

  it("calculates deterministic retry timestamps from attempt count", () => {
    const failure = classifyArchiveError("download", "network reset");

    expect(calculateNextRetryAt(failure, 1, "2026-05-18T00:00:00.000Z")).toBe(
      "2026-05-18T00:05:00.000Z",
    );
    expect(calculateNextRetryAt(failure, 3, "2026-05-18T00:00:00.000Z")).toBe(
      "2026-05-18T02:00:00.000Z",
    );
  });

  it("classifies auth and cookie failures as terminal", () => {
    const failure = classifyArchiveError(
      "download",
      new CommandError(
        commandResult({ stderr: "ERROR: login required; cookie expired" }),
      ),
    );

    expect(failure).toMatchObject({
      kind: "terminal_auth_cookie_invalid",
      terminal: true,
      retryable: false,
    });
  });

  it("classifies filesystem permission failures as terminal", () => {
    const error = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });

    expect(classifyArchiveError("store", error)).toMatchObject({
      kind: "terminal_filesystem_permission",
      terminal: true,
      retryable: false,
    });
  });

  it("classifies filesystem path failures as terminal", () => {
    const error = Object.assign(new Error("File name too long"), {
      code: "ENAMETOOLONG",
    });

    expect(classifyArchiveError("store", error)).toMatchObject({
      kind: "terminal_filesystem_path",
      terminal: true,
      retryable: false,
    });
  });

  it("does not treat numeric URL paths as remote 5xx failures", () => {
    const failure = classifyArchiveError(
      "download",
      new CommandError(
        commandResult({
          stderr:
            "ERROR: unable to open for writing: [Errno 36] File name too long",
          args: ["https://example.com/media/567"],
        }),
      ),
    );

    expect(failure).toMatchObject({
      kind: "terminal_filesystem_path",
      terminal: true,
      retryable: false,
    });
  });

  it("classifies existing path collisions as filesystem path failures", () => {
    const error = Object.assign(new Error("directory not empty"), {
      code: "ENOTEMPTY",
    });

    expect(classifyArchiveError("store", error)).toMatchObject({
      kind: "terminal_filesystem_path",
      terminal: true,
      retryable: false,
    });
  });
});
