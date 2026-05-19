import * as http2 from "http2";

import * as restate from "@restatedev/restate-sdk";
import { Pool } from "pg";

import { readRuntimeConfig } from "./config";
import { ArchiveDatabase } from "./db";
import { initialMigrationSql } from "./migrations";
import { createUrlMediaArchive, createUrlMediaJob } from "./service";
import {
  cleanupArchiveFinalDir,
  cleanupDownloadTempDir,
  storeFilesystemOutputs,
} from "./sinks/filesystem";
import { createYtDlpClient } from "./ytdlp";

void main();

async function main(): Promise<void> {
  const command = process.argv[2] ?? "worker";
  if (command === "migrate") {
    await migrate();
    return;
  }
  if (command !== "worker") {
    throw new Error(`Unknown url-media-archive command: ${command}`);
  }

  const config = readRuntimeConfig();
  const db = config.databaseUrl
    ? new ArchiveDatabase(new Pool({ connectionString: config.databaseUrl }))
    : undefined;
  const ytdlp = createYtDlpClient({
    binary: config.ytDlpBinary,
    cookiesFile: config.cookiePath,
    probeTimeoutMs: config.ytDlpProbeTimeoutMs,
    downloadTimeoutMs: config.ytDlpDownloadTimeoutMs,
    probeConcurrency: config.ytDlpProbeConcurrency,
    downloadConcurrency: config.ytDlpDownloadConcurrency,
  });
  const handler = restate.createEndpointHandler({
    services: [
      createUrlMediaArchive({ db }),
      createUrlMediaJob({
        db,
        prober: ytdlp,
        downloader: ytdlp,
        sink: { store: storeFilesystemOutputs },
        cleanupFinalDir: { cleanup: cleanupArchiveFinalDir },
        cleanupTempDir: { cleanup: cleanupDownloadTempDir },
        archiveRoot: config.archiveRoot,
        keepFailedTempDirs: config.keepFailedTempDirs,
      }),
    ],
    identityKeys: config.restateIdentityKeys,
  });

  await new Promise<void>((resolve, reject) => {
    const server = http2.createServer(handler);
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function migrate(): Promise<void> {
  const config = readRuntimeConfig();
  if (!config.databaseUrl) {
    throw new Error(
      "URL_MEDIA_ARCHIVE_DATABASE_URL or URL_MEDIA_ARCHIVE_DATABASE_URL_FILE is required for migrations",
    );
  }

  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    await pool.query(initialMigrationSql);
  } finally {
    await pool.end();
  }
}
