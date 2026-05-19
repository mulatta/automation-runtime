import { CommandError, type CommandResult } from "../src/childProcess";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  createYtDlpClient,
  downloadWithYtDlp,
  probeWithYtDlp,
} from "../src/ytdlp";

function commandResult(overrides: Partial<CommandResult>): CommandResult {
  return {
    command: "yt-dlp",
    args: [],
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...overrides,
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}

describe("downloadWithYtDlp", () => {
  it("downloads with fixed yt-dlp args and reports media files", async () => {
    const targetDir = mkdtempSync(join(tmpdir(), "media-archive-ytdlp-"));
    const runCommand = jest.fn().mockImplementation(() => {
      writeFileSync(join(targetDir, "video.mp4"), "media");
      writeFileSync(join(targetDir, "video.info.json"), "{}");
      return Promise.resolve(commandResult({ stdout: "" }));
    });

    const result = await downloadWithYtDlp("https://example.com/video", {
      binary: "/bin/yt-dlp",
      cookiesFile: "/run/cookies.txt",
      targetDir,
      timeoutMs: 5678,
      runCommand,
    });

    expect(runCommand).toHaveBeenCalledWith(
      "/bin/yt-dlp",
      [
        "--no-playlist",
        "--paths",
        targetDir,
        "--output",
        "%(id)s.%(ext)s",
        "--write-info-json",
        "--cookies",
        "/run/cookies.txt",
        "https://example.com/video",
      ],
      { timeoutMs: 5678 },
    );
    expect(result.files).toEqual([join(targetDir, "video.mp4")]);
  });
});

describe("probeWithYtDlp", () => {
  it("invokes yt-dlp with JSON probe flags and cookie file", async () => {
    const runCommand = jest.fn().mockResolvedValue(
      commandResult({
        stdout: JSON.stringify({
          id: "123",
          title: "Example",
          extractor: "generic",
          webpage_url: "https://example.com/video",
          formats: [
            { format_id: "http", url: "https://cdn.example/video.mp4" },
          ],
        }),
      }),
    );

    const result = await probeWithYtDlp("https://example.com/video", {
      binary: "/bin/yt-dlp",
      cookiesFile: "/run/cookies.txt",
      timeoutMs: 1234,
      runCommand,
    });

    expect(runCommand).toHaveBeenCalledWith(
      "/bin/yt-dlp",
      [
        "--dump-single-json",
        "--no-playlist",
        "--skip-download",
        "--cookies",
        "/run/cookies.txt",
        "https://example.com/video",
      ],
      { timeoutMs: 1234 },
    );
    expect(result).toMatchObject({
      hasMedia: true,
      probeStatus: "has_media",
      retryable: false,
      terminal: false,
      metadata: {
        id: "123",
        title: "Example",
        extractor: "generic",
        webpageUrl: "https://example.com/video",
      },
    });
  });

  it("classifies empty JSON probe output as no media", async () => {
    const result = await probeWithYtDlp("https://example.com/post", {
      runCommand: jest.fn().mockResolvedValue(
        commandResult({
          stdout: JSON.stringify({
            id: "post",
            title: "Plain post",
            extractor: "generic",
            formats: [],
          }),
        }),
      ),
    });

    expect(result).toMatchObject({
      hasMedia: false,
      probeStatus: "no_media",
      retryable: false,
      terminal: true,
    });
  });

  it("classifies login failures as auth-required terminal failures", async () => {
    const failure = commandResult({
      exitCode: 1,
      stderr: "ERROR: This video is private, login required",
    });
    const result = await probeWithYtDlp("https://example.com/private", {
      runCommand: jest.fn().mockRejectedValue(new CommandError(failure)),
    });

    expect(result).toMatchObject({
      hasMedia: false,
      probeStatus: "auth_required",
      retryable: false,
      terminal: true,
      error: {
        type: "auth_required",
        exitCode: 1,
      },
    });
  });

  it("classifies timeouts as retryable unavailable failures", async () => {
    const failure = commandResult({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      stderr: "timed out after 5ms",
    });
    const result = await probeWithYtDlp("https://example.com/slow", {
      runCommand: jest.fn().mockRejectedValue(new CommandError(failure)),
    });

    expect(result).toMatchObject({
      hasMedia: false,
      probeStatus: "unavailable",
      retryable: true,
      terminal: false,
      error: { type: "retryable_network_timeout" },
    });
  });

  it("classifies rate limits as retryable failures", async () => {
    const failure = commandResult({
      exitCode: 1,
      stderr:
        "WARNING: [example] Rate-limit exceeded; falling back to syndication endpoint",
    });
    const result = await probeWithYtDlp("https://example.com/media/123", {
      runCommand: jest.fn().mockRejectedValue(new CommandError(failure)),
    });

    expect(result).toMatchObject({
      hasMedia: false,
      probeStatus: "unavailable",
      retryable: true,
      terminal: false,
      error: { type: "retryable_rate_limit" },
    });
  });
});

describe("createYtDlpClient", () => {
  it("limits concurrent probes", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const runCommand = jest.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return commandResult({
        stdout: JSON.stringify({
          id: "123",
          title: "Example",
          extractor: "generic",
          formats: [
            { format_id: "http", url: "https://cdn.example/video.mp4" },
          ],
        }),
      });
    });
    const client = createYtDlpClient({ probeConcurrency: 2, runCommand });

    const probes = ["1", "2", "3", "4"].map((id) =>
      client.probe(`https://example.com/media/${id}`),
    );

    await waitUntil(() => releases.length === 2);
    expect(runCommand).toHaveBeenCalledTimes(2);

    while (releases.length > 0) {
      releases.shift()?.();
      await waitUntil(
        () => releases.length > 0 || runCommand.mock.calls.length === 4,
      );
    }

    await Promise.all(probes);
    expect(maxActive).toBe(2);
  });
});
