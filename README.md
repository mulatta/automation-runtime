# restate-workflows

Reusable Restate workflows and workers.

## Media archive worker

`packages/media-archive` is a generic URL-to-filesystem archive worker:

```text
n8n        = URL discovery and trigger
Postgres   = generic URL archive catalog
Restate    = durable archive execution
filesystem = final sink under /var/lib/media-archive/archive
```

Discovery callers submit URLs to `MediaArchive.submitDiscoveredUrl`. Restate canonicalizes and upserts catalog rows, then sends work to `MediaJob/{jobKey}`. `yt-dlp` probes and downloads media.

Final files are stored under:

```text
/var/lib/media-archive/archive/db/YYYY/MM/<job-id>/...
```

Temporary downloads use:

```text
/var/lib/media-archive/archive/.tmp/<safe-job-key>
```

Successful jobs always clean temp directories. Failed jobs clean temp directories by default; set `MEDIA_ARCHIVE_KEEP_FAILED_TEMP_DIRS=true` or NixOS `keepFailedTempDirs = true` to preserve failed temp dirs for debugging. Store failures also best-effort clean the current job final directory so partial moved files do not become catalog orphans.

## Restate services

```text
MediaArchive      submitDiscoveredUrl/submitJob/submitUrl/drainPending/status/statusBySource
MediaJob/{key}    Virtual Object that executes one archive job and caches runtime state
```

DB-backed jobs are the only submission path. `submitUrl` records manual URL submissions in the archive catalog before dispatching `MediaJob/{jobKey}`. Status APIs return catalog status, last error details, and filesystem outputs when available. `drainPending` returns accepted jobs plus due/not-due queue summary counts.

## API examples

Submit a discovered URL from a source such as n8n:

```bash
curl --fail --silent --show-error \
  -H 'content-type: application/json' \
  --data '{
    "source": "example-feed",
    "sourceKey": "item-12345",
    "url": "https://example.com/media/12345",
    "metadata": {"author": "example-user"}
  }' \
  http://127.0.0.1:8080/MediaArchive/submitDiscoveredUrl
```

Response:

```json
{
  "accepted": true,
  "jobKey": "pg:018f6e9d-4a31-7565-982a-cb5e5f01d31f",
  "jobId": "018f6e9d-4a31-7565-982a-cb5e5f01d31f",
  "sourceId": "018f6e9d-4a31-7565-982a-cb5e5f01d320"
}
```

Submit a manual URL without source metadata:

```bash
curl --fail --silent --show-error \
  -H 'content-type: application/json' \
  --data '{"url":"https://example.com/video"}' \
  http://127.0.0.1:8080/MediaArchive/submitUrl
```

Lookup status by source:

```bash
curl --fail --silent --show-error \
  -H 'content-type: application/json' \
  --data '{"source":"example-feed","sourceKey":"item-12345"}' \
  http://127.0.0.1:8080/MediaArchive/statusBySource
```

Status response includes catalog fields, last error, and stored outputs:

```json
{
  "id": "018f6e9d-4a31-7565-982a-cb5e5f01d31f",
  "url": "https://example.com/media/12345",
  "canonicalUrl": "https://example.com/media/12345",
  "status": "stored",
  "probeStatus": "has_media",
  "attempts": 1,
  "nextRetryAt": null,
  "error": {},
  "outputs": [
    {
      "sinkType": "filesystem",
      "path": "/var/lib/media-archive/archive/db/2026/05/018f6e9d-4a31-7565-982a-cb5e5f01d31f/video.mp4",
      "bytes": 1024,
      "mimeType": "video/mp4",
      "sha256": "...",
      "metadata": { "canonicalUrl": "https://example.com/media/12345" }
    }
  ]
}
```

Lookup by canonicalized URL or DB-backed job key:

```bash
curl --fail --silent --show-error \
  -H 'content-type: application/json' \
  --data '{"url":"https://example.com/media/12345?utm_source=ignored"}' \
  http://127.0.0.1:8080/MediaArchive/status

curl --fail --silent --show-error \
  -H 'content-type: application/json' \
  --data '{"jobKey":"pg:018f6e9d-4a31-7565-982a-cb5e5f01d31f"}' \
  http://127.0.0.1:8080/MediaArchive/status
```

`pg:<uuid>` job keys resolve through the durable catalog. Other job key formats return only runtime `MediaJob` object state.

Drain due pending/retryable jobs:

```bash
curl --fail --silent --show-error \
  -H 'content-type: application/json' \
  --data '{"limit":25,"source":"example-feed","statuses":["pending","failed"]}' \
  http://127.0.0.1:8080/MediaArchive/drainPending
```

Drain response:

```json
{
  "accepted": 1,
  "skipped": 0,
  "due": 1,
  "notDue": 0,
  "byStatus": { "failed": 1 },
  "jobKeys": ["pg:018f6e9d-4a31-7565-982a-cb5e5f01d31f"]
}
```

## Status and retry behavior

Archive statuses:

```text
pending -> probing -> downloading -> stored
pending -> probing -> no_media
pending -> probing/downloading -> failed -> pending retry via drainPending
pending -> probing/downloading -> terminal_failed
```

Retryable failures get `status = "failed"` and `nextRetryAt` set. `drainPending` only dispatches failed jobs when `nextRetryAt` is null or due. Terminal failures use `terminal_failed` and do not retry.

Default retry backoff:

```text
network/timeout/5xx/unknown: 5m -> 30m -> 2h -> 12h -> 24h
rate limit:                  30m -> 2h -> 12h -> 24h
```

## Runtime configuration

Key environment variables:

```text
MEDIA_ARCHIVE_HOST
MEDIA_ARCHIVE_PORT
MEDIA_ARCHIVE_ROOT
MEDIA_ARCHIVE_RESTATE_IDENTITY_KEYS
MEDIA_ARCHIVE_DATABASE_URL / MEDIA_ARCHIVE_DATABASE_URL_FILE
MEDIA_ARCHIVE_COOKIE_PATH
MEDIA_ARCHIVE_YTDLP_BINARY
MEDIA_ARCHIVE_YTDLP_PROBE_TIMEOUT_MS
MEDIA_ARCHIVE_YTDLP_DOWNLOAD_TIMEOUT_MS
MEDIA_ARCHIVE_KEEP_FAILED_TEMP_DIRS
```

NixOS module options live under `services.restateWorkers.media-archive`:

```nix
{
  enable = true;
  package = self.packages.${pkgs.system}.media-archive;
  host = "127.0.0.1";
  restateAdminUrl = "http://127.0.0.1:9070";
  endpointUrl = "http://127.0.0.1:9080";
  archiveRoot = "/var/lib/media-archive/archive";
  keepFailedTempDirs = false;

  requestIdentity.publicKeys = [
    "publickeyv1_..."
  ];

  cookiePath = "/var/lib/media-archive/cookies/browser.netscape.txt";

  database = {
    createLocally = true;
    name = "media-archive";
    user = "media-archive";
    urlFile = null;
  };
}
```

The NixOS module owns worker-specific PostgreSQL database, yt-dlp, archive root, migration service, worker service, and Restate deployment registration wiring. It only passes `cookiePath` to yt-dlp; create and refresh the cookie file out of band with the worker user/group permissions. Registration waits for the worker `/health` endpoint before calling the Restate Admin API. Set `requestIdentity.publicKeys` to require Restate Server request signatures on discovery and invocation requests; `/health` remains unsigned for readiness probes.

## Development

```bash
npm install
npm test -- --runInBand
npm run typecheck
npm run lint
npm run build
```

Handler logic changes require replay coverage. This repo uses NixOS replay tests with Restate worker inactivity timeout set to zero.

```bash
nix build .#checks.x86_64-linux.media-archive-replay
nix build .#checks.x86_64-linux.media-archive-keep-failed-temp
```

Package build:

```bash
nix build .#packages.aarch64-darwin.media-archive
```
