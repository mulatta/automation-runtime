# automation-runtime

Typed edge adapters, shared contracts, and durable job runtimes for personal automation.

This repository owns runtime code: HTTP/webhook adapters, schema contracts, Restate coordination helpers, and durable workers. It does not own machine deployment, agent personality, or generic CLI skill documentation; keep those in dotfiles/OpenCrow configuration and skills repositories.

Current packages are still Restate-centered because the first durable runtime is `url-media-archive`. Future edge adapters and contracts should stay thin: validate, normalize, and dispatch work without becoming the durable state owner or agent policy layer.

## URL media archive worker

`packages/url-media-archive` is a generic URL-to-filesystem archive worker:

```text
n8n        = URL discovery and trigger
Postgres   = generic URL archive catalog
Restate    = durable archive execution
filesystem = final sink under /var/lib/url-media-archive/archive
```

Discovery callers submit URLs to `UrlMediaArchive.submitDiscoveredUrl`. Restate canonicalizes and upserts catalog rows, then sends work to `UrlMediaWorkflow/{jobId}`. Workflows wait through retry backoff, acquire a per-host lease, and call `UrlMediaAttempt/{jobKey}` to probe and download with `yt-dlp`.

Final files are stored under:

```text
/var/lib/url-media-archive/archive/db/YYYY/MM/<job-id>/...
```

Temporary downloads use:

```text
/var/lib/url-media-archive/archive/.tmp/<safe-job-key>
```

Successful jobs always clean temp directories. Failed jobs clean temp directories by default; set `URL_MEDIA_ARCHIVE_KEEP_FAILED_TEMP_DIRS=true` or NixOS `keepFailedTempDirs = true` to preserve failed temp dirs for debugging. Store failures also best-effort clean the current job final directory so partial moved files do not become catalog orphans.

## Restate services

```text
UrlMediaArchive                 submitDiscoveredUrl/submitJob/submitUrl/drainPending/status/statusBySource/startDiscoveryScan/getDiscoveryState/recordDiscoveryPage
UrlMediaWorkflow/{jobId}        Workflow that owns retry sleep and job lifecycle dispatch
UrlMediaAttempt/{jobKey}        Virtual Object that executes one archive attempt
UrlMediaArchiveHostLeaseQueue   DurableLeaseQueue instance for per-host serialization
UrlMediaArchiveRateLimit        DurableRateLimiter instance for yt-dlp pacing
```

DB-backed jobs are the only submission path. `submitUrl` records manual URL submissions in the archive catalog before dispatching `UrlMediaWorkflow/{jobId}`. Status APIs return catalog status, last error details, and filesystem outputs when available. `drainPending` remains an operational API that sends workflows for due jobs and returns accepted jobs plus due/not-due summary counts.

Discovery state also lives in Postgres. `startDiscoveryScan` reads or resets a source cursor, `recordDiscoveryPage` records one discovered page with optimistic state version checking, upserts discovered URLs, and dispatches the resulting workflows. This keeps n8n as an API caller instead of the source of archive/discovery truth.

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
  http://127.0.0.1:8080/UrlMediaArchive/submitDiscoveredUrl
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
  http://127.0.0.1:8080/UrlMediaArchive/submitUrl
```

Lookup status by source:

```bash
curl --fail --silent --show-error \
  -H 'content-type: application/json' \
  --data '{"source":"example-feed","sourceKey":"item-12345"}' \
  http://127.0.0.1:8080/UrlMediaArchive/statusBySource
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
      "path": "/var/lib/url-media-archive/archive/db/2026/05/018f6e9d-4a31-7565-982a-cb5e5f01d31f/video.mp4",
      "bytes": 1024,
      "mimeType": "video/mp4",
      "blake3": "...",
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
  http://127.0.0.1:8080/UrlMediaArchive/status

curl --fail --silent --show-error \
  -H 'content-type: application/json' \
  --data '{"jobKey":"pg:018f6e9d-4a31-7565-982a-cb5e5f01d31f"}' \
  http://127.0.0.1:8080/UrlMediaArchive/status
```

`pg:<uuid>` job keys resolve through the durable catalog. Other job key formats return `null`.

Drain due pending/retryable jobs:

```bash
curl --fail --silent --show-error \
  -H 'content-type: application/json' \
  --data '{"limit":25,"source":"example-feed","statuses":["pending","failed"]}' \
  http://127.0.0.1:8080/UrlMediaArchive/drainPending
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
pending -> probing/downloading -> failed -> retry via UrlMediaWorkflow sleep
pending -> probing/downloading -> terminal_failed
```

Retryable failures get `status = "failed"` and `nextRetryAt` set. `UrlMediaWorkflow` sleeps until `nextRetryAt` and retries automatically; `drainPending` only dispatches failed jobs when `nextRetryAt` is null or already due. Terminal failures use `terminal_failed` and do not retry.

Default retry backoff:

```text
network/timeout/5xx/unknown: 5m -> 30m -> 2h -> 12h -> 24h
rate limit:                  12h -> 24h
```

## Runtime configuration

Key environment variables:

```text
URL_MEDIA_ARCHIVE_HOST
URL_MEDIA_ARCHIVE_PORT
URL_MEDIA_ARCHIVE_ROOT
URL_MEDIA_ARCHIVE_RESTATE_IDENTITY_KEYS
URL_MEDIA_ARCHIVE_DATABASE_URL / URL_MEDIA_ARCHIVE_DATABASE_URL_FILE
URL_MEDIA_ARCHIVE_COOKIE_PATH
URL_MEDIA_ARCHIVE_YTDLP_BINARY
URL_MEDIA_ARCHIVE_YTDLP_PROBE_TIMEOUT_MS
URL_MEDIA_ARCHIVE_YTDLP_DOWNLOAD_TIMEOUT_MS
URL_MEDIA_ARCHIVE_YTDLP_PROBE_CONCURRENCY
URL_MEDIA_ARCHIVE_YTDLP_DOWNLOAD_CONCURRENCY
URL_MEDIA_ARCHIVE_YTDLP_REQUEST_MIN_INTERVAL_MS
URL_MEDIA_ARCHIVE_YTDLP_REQUEST_JITTER_MS
URL_MEDIA_ARCHIVE_KEEP_FAILED_TEMP_DIRS
```

NixOS module options live under `services.restateWorkers.url-media-archive`:

```nix
{
  enable = true;
  package = self.packages.${pkgs.system}.url-media-archive;
  host = "127.0.0.1";
  restateAdminUrl = "http://127.0.0.1:9070";
  endpointUrl = "http://127.0.0.1:9080";
  archiveRoot = "/var/lib/url-media-archive/archive";
  keepFailedTempDirs = false;
  ytDlpProbeConcurrency = 2;
  ytDlpDownloadConcurrency = 2;
  ytDlpRequestMinIntervalMs = 90000;
  ytDlpRequestJitterMs = 60000;

  requestIdentity.publicKeys = [
    "publickeyv1_..."
  ];

  cookiePath = "/var/lib/url-media-archive/cookies/browser.netscape.txt";

  database = {
    createLocally = true;
    name = "url-media-archive";
    user = "url-media-archive";
    urlFile = null;
  };
}
```

The NixOS module owns worker-specific PostgreSQL database, yt-dlp, archive root, migration service, worker service, and Restate deployment registration wiring. It only passes `cookiePath` to yt-dlp; create and refresh the cookie file out of band with the worker user/group permissions. `ytDlpRequestMinIntervalMs` enables a durable per-host Restate rate limiter before probe and download steps, so large drains cannot issue back-to-back yt-dlp requests for the same hostname. `ytDlpRequestJitterMs` adds deterministic Restate jitter to each reserved slot to avoid fixed request cadence. Registration waits for the worker `/health` endpoint before calling the Restate Admin API. Set `requestIdentity.publicKeys` to require Restate Server request signatures on discovery and invocation requests; `/health` remains unsigned for readiness probes.

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
nix build .#checks.x86_64-linux.url-media-archive-replay
nix build .#checks.x86_64-linux.url-media-archive-keep-failed-temp
```

Package build:

```bash
nix build .#packages.aarch64-darwin.url-media-archive
```
