import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readRuntimeConfig } from "../src/config";

describe("runtime config", () => {
  it("prefers inline database URL over file", () => {
    const dir = mkdtempSync(join(tmpdir(), "url-media-archive-config-"));
    const file = join(dir, "database-url");
    writeFileSync(file, "postgresql:///from-file\n");

    expect(
      readRuntimeConfig({
        URL_MEDIA_ARCHIVE_DATABASE_URL: "postgresql:///inline",
        URL_MEDIA_ARCHIVE_DATABASE_URL_FILE: file,
        URL_MEDIA_ARCHIVE_ROOT: "/srv/archive",
      }),
    ).toMatchObject({
      databaseUrl: "postgresql:///inline",
      archiveRoot: "/srv/archive",
    });
  });

  it("reads database URL from credential file", () => {
    const dir = mkdtempSync(join(tmpdir(), "url-media-archive-config-"));
    const file = join(dir, "database-url");
    writeFileSync(file, "postgresql:///from-file\n");

    expect(
      readRuntimeConfig({ URL_MEDIA_ARCHIVE_DATABASE_URL_FILE: file }),
    ).toMatchObject({ databaseUrl: "postgresql:///from-file" });
  });

  it("defaults to deleting failed temp directories", () => {
    expect(readRuntimeConfig({})).toMatchObject({
      keepFailedTempDirs: false,
    });
  });

  it("parses boolean feature flags", () => {
    for (const value of ["true", "1", "yes", "on"]) {
      expect(
        readRuntimeConfig({ URL_MEDIA_ARCHIVE_KEEP_FAILED_TEMP_DIRS: value }),
      ).toMatchObject({ keepFailedTempDirs: true });
    }
    for (const value of ["false", "0", "no", "off"]) {
      expect(
        readRuntimeConfig({ URL_MEDIA_ARCHIVE_KEEP_FAILED_TEMP_DIRS: value }),
      ).toMatchObject({ keepFailedTempDirs: false });
    }
  });

  it("rejects invalid boolean feature flags", () => {
    expect(() =>
      readRuntimeConfig({ URL_MEDIA_ARCHIVE_KEEP_FAILED_TEMP_DIRS: "maybe" }),
    ).toThrow("Invalid boolean: maybe");
  });

  it("defaults to localhost bind without request identity", () => {
    expect(readRuntimeConfig({})).toMatchObject({
      host: "127.0.0.1",
      restateIdentityKeys: [],
    });
  });

  it("prefers cookie path while accepting legacy cookie file", () => {
    expect(
      readRuntimeConfig({
        URL_MEDIA_ARCHIVE_COOKIE_FILE: "/legacy/cookies.txt",
        URL_MEDIA_ARCHIVE_COOKIE_PATH: "/run/cookies.txt",
      }),
    ).toMatchObject({ cookiePath: "/run/cookies.txt" });

    expect(
      readRuntimeConfig({
        URL_MEDIA_ARCHIVE_COOKIE_FILE: "/legacy/cookies.txt",
      }),
    ).toMatchObject({ cookiePath: "/legacy/cookies.txt" });
  });

  it("parses Restate request identity keys", () => {
    expect(
      readRuntimeConfig({
        URL_MEDIA_ARCHIVE_RESTATE_IDENTITY_KEYS:
          "publickeyv1_one, publickeyv1_two\npublickeyv1_three",
      }),
    ).toMatchObject({
      restateIdentityKeys: [
        "publickeyv1_one",
        "publickeyv1_two",
        "publickeyv1_three",
      ],
    });
  });

  it("reads yt-dlp executable, timeouts, and concurrency limits", () => {
    expect(readRuntimeConfig({})).toMatchObject({
      ytDlpProbeConcurrency: 2,
      ytDlpDownloadConcurrency: 2,
      ytDlpRequestMinIntervalMs: 0,
    });

    expect(
      readRuntimeConfig({
        URL_MEDIA_ARCHIVE_YTDLP_BINARY: "/run/current-system/sw/bin/yt-dlp",
        URL_MEDIA_ARCHIVE_YTDLP_PROBE_TIMEOUT_MS: "30000",
        URL_MEDIA_ARCHIVE_YTDLP_DOWNLOAD_TIMEOUT_MS: "600000",
        URL_MEDIA_ARCHIVE_YTDLP_PROBE_CONCURRENCY: "3",
        URL_MEDIA_ARCHIVE_YTDLP_DOWNLOAD_CONCURRENCY: "4",
        URL_MEDIA_ARCHIVE_YTDLP_REQUEST_MIN_INTERVAL_MS: "60000",
      }),
    ).toMatchObject({
      ytDlpBinary: "/run/current-system/sw/bin/yt-dlp",
      ytDlpProbeTimeoutMs: 30000,
      ytDlpDownloadTimeoutMs: 600000,
      ytDlpProbeConcurrency: 3,
      ytDlpDownloadConcurrency: 4,
      ytDlpRequestMinIntervalMs: 60000,
    });
  });
});
