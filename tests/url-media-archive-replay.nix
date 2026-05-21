{
  lib,
  urlMediaArchivePackage,
  pkgs,
  restatePackage,
}:
let
  restateConfig = (pkgs.formats.toml { }).generate "restate-test.toml" {
    "base-dir" = "/var/lib/restate";
    "bind-address" = "127.0.0.1:5122";
    admin."bind-address" = "127.0.0.1:9070";
    ingress."bind-address" = "127.0.0.1:8080";
    worker.invoker."inactivity-timeout" = "0m";
  };
  fakeYtDlp = pkgs.writeShellScriptBin "yt-dlp" ''
    set -euo pipefail
    if [[ " $* " == *" --dump-single-json "* ]]; then
      if [[ " $* " == *"media/234"* ]]; then
        cat <<'JSON'
    {"id":"234","title":"No media fixture","extractor":"test","webpage_url":"https://example.com/media/234","formats":[]}
    JSON
      elif [[ " $* " == *"media/345"* ]]; then
        cat <<'JSON'
    {"id":"345","title":"Manual URL fixture","extractor":"test","webpage_url":"https://example.com/media/345","formats":[{"format_id":"http","url":"https://cdn.example.invalid/video.mp4"}]}
    JSON
      elif [[ " $* " == *"media/456"* ]]; then
        cat <<'JSON'
    {"id":"456","title":"Expired cookie fixture","extractor":"test","webpage_url":"https://example.com/media/456","formats":[{"format_id":"http","url":"https://cdn.example.invalid/video.mp4"}]}
    JSON
      elif [[ " $* " == *"media/567"* ]]; then
        cat <<'JSON'
    {"id":"567","title":"Store failure fixture","extractor":"test","webpage_url":"https://example.com/media/567","formats":[{"format_id":"http","url":"https://cdn.example.invalid/video.mp4"}]}
    JSON
      elif [[ " $* " == *"media/678"* ]]; then
        echo "WARNING: [example] Rate-limit exceeded; falling back to syndication endpoint" >&2
        exit 1
      elif [[ " $* " == *"media/789"* ]]; then
        cat <<'JSON'
    {"id":"789","title":"Retry fixture","extractor":"test","webpage_url":"https://example.com/media/789","formats":[{"format_id":"http","url":"https://cdn.example.invalid/video.mp4"}]}
    JSON
      elif [[ " $* " == *"media/890"* ]]; then
        cat <<'JSON'
    {"id":"890","title":"No video download fixture","extractor":"test","webpage_url":"https://example.com/media/890","formats":[{"format_id":"http","url":"https://cdn.example.invalid/video.mp4"}]}
    JSON
      elif [[ " $* " == *"media/891"* ]]; then
        cat <<'JSON'
    {"id":"891","title":"Rate limited no video fixture","extractor":"test","webpage_url":"https://example.com/media/891","formats":[{"format_id":"http","url":"https://cdn.example.invalid/video.mp4"}]}
    JSON
      elif [[ " $* " == *"media/910"* ]]; then
        cat <<'JSON'
    {"id":"910","title":"Same host fixture 910","extractor":"test","webpage_url":"https://example.com/media/910","formats":[{"format_id":"http","url":"https://cdn.example.invalid/video.mp4"}]}
    JSON
      elif [[ " $* " == *"media/911"* ]]; then
        cat <<'JSON'
    {"id":"911","title":"Same host fixture 911","extractor":"test","webpage_url":"https://example.com/media/911","formats":[{"format_id":"http","url":"https://cdn.example.invalid/video.mp4"}]}
    JSON
      elif [[ " $* " == *"media/920"* ]]; then
        cat <<'JSON'
    {"id":"920","title":"Different host fixture 920","extractor":"test","webpage_url":"https://other.example.com/media/920","formats":[{"format_id":"http","url":"https://cdn.example.invalid/video.mp4"}]}
    JSON
      elif [[ " $* " == *"media/921"* ]]; then
        cat <<'JSON'
    {"id":"921","title":"Different host fixture 921","extractor":"test","webpage_url":"https://third.example.com/media/921","formats":[{"format_id":"http","url":"https://cdn.example.invalid/video.mp4"}]}
    JSON
      else
        cat <<'JSON'
    {"id":"123","title":"Replay fixture","extractor":"test","webpage_url":"https://example.com/media/123","formats":[{"format_id":"http","url":"https://cdn.example.invalid/video.mp4"}]}
    JSON
      fi
      exit 0
    fi

    download_args=" $* "
    target_dir=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --paths)
          target_dir="$2"
          shift 2
          ;;
        *)
          shift
          ;;
      esac
    done
    mkdir -p "$target_dir"

    if [[ "$download_args" == *"media/456"* ]]; then
      printf 'failed temp\n' > "$target_dir/failure-marker.part"
      echo "ERROR: login required; cookie expired" >&2
      exit 1
    fi

    if [[ "$download_args" == *"media/567"* ]]; then
      echo "ERROR: unable to open for writing: [Errno 36] File name too long" >&2
      exit 1
    fi

    if [[ "$download_args" == *"media/789"* && ! -e /tmp/yt-dlp-789-first-failure ]]; then
      touch /tmp/yt-dlp-789-first-failure
      printf 'retry temp\n' > "$target_dir/retry-marker.part"
      echo "ERROR: network timed out" >&2
      exit 1
    fi

    if [[ "$download_args" == *"media/890"* ]]; then
      echo "ERROR: [example] 890: No video could be found in this item" >&2
      exit 1
    fi

    if [[ "$download_args" == *"media/891"* ]]; then
      echo "WARNING: [example] Rate-limit exceeded; falling back to syndication endpoint" >&2
      echo "ERROR: [example] 891: No video could be found in this item" >&2
      exit 1
    fi

    if [[ "$download_args" == *"media/910"* || "$download_args" == *"media/911"* ]]; then
      if ! mkdir /tmp/same-host-download.lock 2>/dev/null; then
        touch /tmp/same-host-overlap
      else
        trap 'rmdir /tmp/same-host-download.lock' EXIT
      fi
      sleep 1
    fi

    if [[ "$download_args" == *"media/920"* ]]; then
      touch /tmp/different-host-920.started
      for _ in $(seq 1 50); do
        [[ -e /tmp/different-host-921.started ]] && break
        sleep 0.1
      done
      if [[ ! -e /tmp/different-host-921.started ]]; then
        echo "ERROR: different-host peer did not run concurrently" >&2
        exit 1
      fi
    fi

    if [[ "$download_args" == *"media/921"* ]]; then
      touch /tmp/different-host-921.started
      for _ in $(seq 1 50); do
        [[ -e /tmp/different-host-920.started ]] && break
        sleep 0.1
      done
      if [[ ! -e /tmp/different-host-920.started ]]; then
        echo "ERROR: different-host peer did not run concurrently" >&2
        exit 1
      fi
    fi

    printf 'media bytes\n' > "$target_dir/replay-fixture.mp4"
    printf '{"id":"123"}\n' > "$target_dir/replay-fixture.info.json"
  '';
in
pkgs.testers.runNixOSTest {
  name = "url-media-archive-replay";

  nodes.machine =
    { ... }:
    {
      imports = [ ../nixosModules/url-media-archive.nix ];

      environment.systemPackages = [
        pkgs.curl
        pkgs.jq
        pkgs.postgresql
      ];

      services.restateWorkers.url-media-archive = {
        enable = true;
        package = urlMediaArchivePackage;
        restateAdminUrl = "http://127.0.0.1:9070";
        endpointUrl = "http://127.0.0.1:9080";
        ytDlpPackage = fakeYtDlp;
        ytDlpRequestMinIntervalMs = 1;
        ytDlpRequestJitterMs = 1;
        cookiePath = "/var/lib/url-media-archive/cookies/browser.netscape.txt";
      };

      services.postgresql.authentication = lib.mkForce ''
        local all all trust
      '';

      users.users.restate = {
        isSystemUser = true;
        group = "restate";
        home = "/var/lib/restate";
      };
      users.groups.restate = { };

      systemd.tmpfiles.rules = [
        "d /var/lib/restate 0750 restate restate -"
      ];

      systemd.services.restate = {
        description = "Restate durable execution server";
        wantedBy = [ "multi-user.target" ];
        after = [ "network.target" ];

        environment = {
          RESTATE_CONFIG = restateConfig;
          RESTATE_WORKER__INVOKER__INACTIVITY_TIMEOUT = "0m";
        };

        serviceConfig = {
          ExecStart = "${lib.getExe' restatePackage "restate-server"}";
          User = "restate";
          Group = "restate";
          WorkingDirectory = "/var/lib/restate";
          ReadWritePaths = [ "/var/lib/restate" ];
          Restart = "always";
          RestartSec = "1s";
        };
      };
    };

  testScript = ''
    import json
    import re

    def temp_dir_for_job_key(job_key):
        return "/var/lib/url-media-archive/archive/.tmp/" + re.sub(r"[^A-Za-z0-9._-]", "_", job_key)

    machine.start()
    machine.wait_for_unit("postgresql.service")
    machine.wait_for_unit("restate.service")
    machine.wait_for_open_port(8080)
    machine.wait_for_open_port(9070)
    machine.wait_until_succeeds("systemctl show -p Result --value url-media-archive-worker-migrate.service | grep '^success$'")
    machine.wait_for_unit("url-media-archive-worker.service")
    machine.wait_for_open_port(9080)
    machine.wait_until_succeeds("systemctl show -p Result --value url-media-archive-worker-register.service | grep '^success$'")
    machine.wait_until_succeeds(
        "curl --fail --silent --show-error --max-time 5 http://127.0.0.1:9070/services "
        "| jq -e '(.services | map(.name)) as $names "
        "| ($names | index(\"UrlMediaWorkflow\") != null) "
        "and ($names | index(\"UrlMediaAttempt\") != null) "
        "and ($names | index(\"UrlMediaArchiveHostLeaseQueue\") != null) "
        "and ($names | index(\"UrlMediaJob\") == null) "
        "and ($names | index(\"UrlMediaArchiveHostQueue\") == null)'",
        timeout=30,
    )

    payload = json.dumps({
        "source": "example-feed",
        "sourceKey": "123",
        "url": "https://example.com/media/123?utm_source=nixos-test",
        "metadata": {"author": "user"},
    })
    machine.wait_until_succeeds(
        "curl --fail --silent --show-error --max-time 5 "
        "-H 'content-type: application/json' "
        f"--data '{payload}' "
        "http://127.0.0.1:8080/UrlMediaArchive/submitDiscoveredUrl > /tmp/accepted-123.json",
        timeout=60,
    )
    response = machine.succeed("cat /tmp/accepted-123.json")
    accepted = json.loads(response)
    assert accepted["accepted"] is True
    assert accepted["jobKey"].startswith("pg:")

    status_payload = json.dumps({"source": "example-feed", "sourceKey": "123"})

    def read_status():
        return machine.succeed(
            "curl --fail --silent --show-error "
            "-H 'content-type: application/json' "
            f"--data '{status_payload}' "
            "http://127.0.0.1:8080/UrlMediaArchive/statusBySource"
        )

    machine.wait_until_succeeds(
        "curl --fail --silent --show-error --max-time 5 "
        "-H 'content-type: application/json' "
        f"--data '{status_payload}' "
        "http://127.0.0.1:8080/UrlMediaArchive/statusBySource | jq -e '.status == \"stored\" and .probeStatus == \"has_media\" and (.outputs | length) == 1 and .error == {}'",
        timeout=60,
    )
    status_json = json.loads(read_status())
    assert status_json["canonicalUrl"] == "https://example.com/media/123"

    machine.succeed(
        "journalctl -u url-media-archive-worker.service --no-pager "
        f"| grep -F 'UrlMediaWorkflow/{accepted['jobId']}/run'"
    )
    machine.succeed(
        "journalctl -u url-media-archive-worker.service --no-pager "
        "| grep -F 'UrlMediaArchiveHostLeaseQueue/example.com/acquire'"
    )

    job_key_status_payload = json.dumps({"jobKey": accepted["jobKey"]})
    machine.succeed(
        "curl --fail --silent --show-error "
        "-H 'content-type: application/json' "
        f"--data '{job_key_status_payload}' "
        "http://127.0.0.1:8080/UrlMediaArchive/status | jq -e '.id == \"%s\" and .status == \"stored\" and (.outputs | length) == 1 and .error == {}'" % accepted["jobId"]
    )

    machine.succeed("find /var/lib/url-media-archive/archive/db -type f | grep -F 'Replay fixture [123].mp4'")
    machine.succeed("find /var/lib/url-media-archive/archive/db -type f | grep -F 'Replay fixture [123].nfo'")
    machine.succeed(f"test ! -d {temp_dir_for_job_key(accepted['jobKey'])}")

    discovery_start_payload = json.dumps({"source": "replay-discovery", "resetCursor": True})
    machine.succeed(
        "curl --fail --silent --show-error --max-time 5 "
        "-H 'content-type: application/json' "
        f"--data '{discovery_start_payload}' "
        "http://127.0.0.1:8080/UrlMediaArchive/startDiscoveryScan > /tmp/discovery-start.json"
    )
    discovery_start = json.loads(machine.succeed("cat /tmp/discovery-start.json"))
    discovery_page_payload = json.dumps({
        "source": "replay-discovery",
        "stateVersion": discovery_start["version"],
        "pageSize": 10,
        "pagesPerRun": 1,
        "fullCoverage": True,
        "startedFromCursor": False,
        "scanStartedAt": "2026-05-18T00:00:00.000Z",
        "paginationToken": "",
        "nextToken": "cursor-2",
        "items": [
            {"sourceKey": "124", "url": "https://example.com/media/124"},
            {"sourceKey": "125", "url": "https://example.com/media/125"},
        ],
    })
    machine.succeed(
        "curl --fail --silent --show-error --max-time 5 "
        "-H 'content-type: application/json' "
        f"--data '{discovery_page_payload}' "
        "http://127.0.0.1:8080/UrlMediaArchive/recordDiscoveryPage > /tmp/discovery-page.json"
    )
    discovery_page = json.loads(machine.succeed("cat /tmp/discovery-page.json"))
    assert discovery_page["accepted"] == 2
    assert discovery_page["pageDiscoveredCount"] == 2
    assert discovery_page["continuePagination"] is False
    assert discovery_page["savedCursor"] == "cursor-2"
    machine.wait_until_succeeds(
        "curl --fail --silent --show-error --max-time 5 "
        "-H 'content-type: application/json' "
        "--data '{\"source\":\"replay-discovery\"}' "
        "http://127.0.0.1:8080/UrlMediaArchive/getDiscoveryState "
        "| jq -e '.nextToken == \"cursor-2\" and .catchupIncomplete == true and .lastSubmittedCount == 2'",
        timeout=30,
    )
    machine.wait_until_succeeds(
        "curl --fail --silent --show-error --max-time 5 "
        "-H 'content-type: application/json' "
        "--data '{\"source\":\"replay-discovery\",\"sourceKey\":\"124\"}' "
        "http://127.0.0.1:8080/UrlMediaArchive/statusBySource | jq -e '.status == \"stored\"'",
        timeout=60,
    )

    workflow_job_id = machine.succeed(
        "timeout 20 psql -h /run/postgresql -U url-media-archive -d url-media-archive -qAt "
        "-c \"WITH inserted AS ("
        "INSERT INTO url_archive_jobs (url, canonical_url, status, next_retry_at) "
        "VALUES ('https://example.com/media/901', 'https://example.com/media/901', 'failed', now() + interval '3 seconds') "
        "RETURNING id) SELECT id FROM inserted\""
    ).strip()
    workflow_payload = json.dumps({"jobId": workflow_job_id, "maxAttemptsPerInvocation": 2})
    machine.succeed(
        "curl --fail --silent --show-error --max-time 5 "
        "-H 'content-type: application/json' "
        f"--data '{workflow_payload}' "
        f"http://127.0.0.1:8080/UrlMediaWorkflow/{workflow_job_id}/run/send"
    )
    machine.wait_until_succeeds(
        "journalctl -u url-media-archive-worker.service --no-pager "
        f"| grep -F 'UrlMediaWorkflow/{workflow_job_id}/run' | grep -F 'Invocation suspended'",
        timeout=20,
    )
    machine.succeed("systemctl restart url-media-archive-worker.service")
    machine.wait_for_unit("url-media-archive-worker.service")
    machine.wait_for_open_port(9080)
    machine.wait_until_succeeds(
        "timeout 20 psql -h /run/postgresql -U url-media-archive -d url-media-archive -At "
        f"-c \"SELECT status || ':' || attempts FROM url_archive_jobs WHERE id = '{workflow_job_id}'\" "
        "| grep '^stored:1$'",
        timeout=60,
    )
    machine.succeed(
        "journalctl -u url-media-archive-worker.service --no-pager "
        "| grep -F 'UrlMediaArchiveHostLeaseQueue/example.com/acquire'"
    )

    terminal_workflow_job_id = machine.succeed(
        "timeout 20 psql -h /run/postgresql -U url-media-archive -d url-media-archive -qAt "
        "-c \"WITH inserted AS ("
        "INSERT INTO url_archive_jobs (url, canonical_url, status, probe_status) "
        "VALUES ('https://terminal.example.com/media/930', 'https://terminal.example.com/media/930', 'no_media', 'no_media') "
        "RETURNING id) SELECT id FROM inserted\""
    ).strip()
    terminal_workflow_payload = json.dumps({"jobId": terminal_workflow_job_id})
    machine.succeed(
        "curl --fail --silent --show-error --max-time 5 "
        "-H 'content-type: application/json' "
        f"--data '{terminal_workflow_payload}' "
        f"http://127.0.0.1:8080/UrlMediaWorkflow/{terminal_workflow_job_id}/run/send"
    )
    machine.wait_until_succeeds(
        "timeout 20 psql -h /run/postgresql -U url-media-archive -d url-media-archive -At "
        f"-c \"SELECT status || ':' || attempts FROM url_archive_jobs WHERE id = '{terminal_workflow_job_id}'\" "
        "| grep '^no_media:0$'",
        timeout=20,
    )
    machine.succeed(
        "! journalctl -u url-media-archive-worker.service --no-pager "
        "| grep -F 'UrlMediaArchiveHostLeaseQueue/terminal.example.com/acquire'"
    )

    for source_key, url in [
        ("910", "https://example.com/media/910"),
        ("911", "https://example.com/media/911"),
    ]:
        same_host_payload = json.dumps({
            "source": "example-feed",
            "sourceKey": source_key,
            "url": url,
            "metadata": {"author": "user"},
        })
        machine.succeed(
            "curl --fail --silent --show-error "
            "-H 'content-type: application/json' "
            f"--data '{same_host_payload}' "
            "http://127.0.0.1:8080/UrlMediaArchive/submitDiscoveredUrl"
        )
    for source_key in ["910", "911"]:
        same_host_status_payload = json.dumps({"source": "example-feed", "sourceKey": source_key})
        machine.wait_until_succeeds(
            "curl --fail --silent --show-error --max-time 5 "
            "-H 'content-type: application/json' "
            f"--data '{same_host_status_payload}' "
            "http://127.0.0.1:8080/UrlMediaArchive/statusBySource | jq -e '.status == \"stored\" and (.outputs | length) == 1 and .error == {}'",
            timeout=60,
        )
    machine.succeed("test ! -e /tmp/same-host-overlap")

    for source_key, url in [
        ("920", "https://other.example.com/media/920"),
        ("921", "https://third.example.com/media/921"),
    ]:
        different_host_payload = json.dumps({
            "source": "example-feed",
            "sourceKey": source_key,
            "url": url,
            "metadata": {"author": "user"},
        })
        machine.succeed(
            "curl --fail --silent --show-error "
            "-H 'content-type: application/json' "
            f"--data '{different_host_payload}' "
            "http://127.0.0.1:8080/UrlMediaArchive/submitDiscoveredUrl"
        )
    for source_key in ["920", "921"]:
        different_host_status_payload = json.dumps({"source": "example-feed", "sourceKey": source_key})
        machine.wait_until_succeeds(
            "curl --fail --silent --show-error --max-time 5 "
            "-H 'content-type: application/json' "
            f"--data '{different_host_status_payload}' "
            "http://127.0.0.1:8080/UrlMediaArchive/statusBySource | jq -e '.status == \"stored\" and (.outputs | length) == 1 and .error == {}'",
            timeout=60,
        )

    no_media_payload = json.dumps({
        "source": "example-feed",
        "sourceKey": "234",
        "url": "https://example.com/media/234",
        "metadata": {"author": "user"},
    })
    no_media_response = machine.succeed(
        "curl --fail --silent --show-error "
        "-H 'content-type: application/json' "
        f"--data '{no_media_payload}' "
        "http://127.0.0.1:8080/UrlMediaArchive/submitDiscoveredUrl"
    )
    no_media_accepted = json.loads(no_media_response)
    no_media_status_payload = json.dumps({"source": "example-feed", "sourceKey": "234"})
    machine.wait_until_succeeds(
        "curl --fail --silent --show-error --max-time 5 "
        "-H 'content-type: application/json' "
        f"--data '{no_media_status_payload}' "
        "http://127.0.0.1:8080/UrlMediaArchive/statusBySource | jq -e '.status == \"no_media\" and .probeStatus == \"no_media\" and .error.type == \"no_media\" and (.outputs | length) == 0'",
        timeout=60,
    )
    machine.succeed(f"test ! -d {temp_dir_for_job_key(no_media_accepted['jobKey'])}")

    manual_payload = json.dumps({
        "url": "https://example.com/media/345?utm_source=manual-test",
        "metadata": {"submittedBy": "replay"},
    })
    manual_response = machine.succeed(
        "curl --fail --silent --show-error "
        "-H 'content-type: application/json' "
        f"--data '{manual_payload}' "
        "http://127.0.0.1:8080/UrlMediaArchive/submitUrl"
    )
    manual_accepted = json.loads(manual_response)
    assert manual_accepted["accepted"] is True
    assert manual_accepted["jobKey"].startswith("pg:")
    assert "jobId" in manual_accepted
    manual_status_payload = json.dumps({"url": "https://example.com/media/345?utm_campaign=ignored"})
    machine.wait_until_succeeds(
        "curl --fail --silent --show-error --max-time 5 "
        "-H 'content-type: application/json' "
        f"--data '{manual_status_payload}' "
        "http://127.0.0.1:8080/UrlMediaArchive/status | jq -e '.status == \"stored\" and .canonicalUrl == \"https://example.com/media/345\" and (.outputs | length) == 1 and .error == {}'",
        timeout=60,
    )
    machine.succeed(f"test ! -d {temp_dir_for_job_key(manual_accepted['jobKey'])}")

    failure_payload = json.dumps({
        "source": "example-feed",
        "sourceKey": "456",
        "url": "https://example.com/media/456",
        "metadata": {"author": "user"},
    })
    failure_response = machine.succeed(
        "curl --fail --silent --show-error "
        "-H 'content-type: application/json' "
        f"--data '{failure_payload}' "
        "http://127.0.0.1:8080/UrlMediaArchive/submitDiscoveredUrl"
    )
    failure_accepted = json.loads(failure_response)
    failure_status_payload = json.dumps({"source": "example-feed", "sourceKey": "456"})
    machine.wait_until_succeeds(
        "curl --fail --silent --show-error --max-time 5 "
        "-H 'content-type: application/json' "
        f"--data '{failure_status_payload}' "
        "http://127.0.0.1:8080/UrlMediaArchive/statusBySource | jq -e '.status == \"terminal_failed\" and .probeStatus == \"has_media\" and .error.type == \"terminal_auth_cookie_invalid\" and (.outputs | length) == 0'",
        timeout=60,
    )
    machine.succeed(f"test ! -d {temp_dir_for_job_key(failure_accepted['jobKey'])}")

    store_failure_payload = json.dumps({
        "source": "example-feed",
        "sourceKey": "567",
        "url": "https://example.com/media/567",
        "metadata": {"author": "user"},
    })
    store_failure_response = machine.succeed(
        "curl --fail --silent --show-error "
        "-H 'content-type: application/json' "
        f"--data '{store_failure_payload}' "
        "http://127.0.0.1:8080/UrlMediaArchive/submitDiscoveredUrl"
    )
    store_failure_accepted = json.loads(store_failure_response)
    store_failure_status_payload = json.dumps({"source": "example-feed", "sourceKey": "567"})
    machine.wait_until_succeeds(
        "curl --fail --silent --show-error --max-time 5 "
        "-H 'content-type: application/json' "
        f"--data '{store_failure_status_payload}' "
        "http://127.0.0.1:8080/UrlMediaArchive/statusBySource | jq -e '.status == \"terminal_failed\" and .probeStatus == \"has_media\" and .error.type == \"terminal_filesystem_path\" and (.outputs | length) == 0'",
        timeout=60,
    )
    machine.succeed(f"test ! -d {temp_dir_for_job_key(store_failure_accepted['jobKey'])}")

    rate_limit_payload = json.dumps({
        "source": "example-feed",
        "sourceKey": "678",
        "url": "https://example.com/media/678",
        "metadata": {"author": "user"},
    })
    machine.succeed(
        "curl --fail --silent --show-error "
        "-H 'content-type: application/json' "
        f"--data '{rate_limit_payload}' "
        "http://127.0.0.1:8080/UrlMediaArchive/submitDiscoveredUrl"
    )
    rate_limit_status_payload = json.dumps({"source": "example-feed", "sourceKey": "678"})
    machine.wait_until_succeeds(
        "curl --fail --silent --show-error --max-time 5 "
        "-H 'content-type: application/json' "
        f"--data '{rate_limit_status_payload}' "
        "http://127.0.0.1:8080/UrlMediaArchive/statusBySource | jq -e '.status == \"failed\" and .probeStatus == \"unavailable\" and .nextRetryAt != null and .error.type == \"retryable_rate_limit\" and .error.retryable == true and .error.terminal == false and (.outputs | length) == 0'",
        timeout=60,
    )

    unsupported_download_payload = json.dumps({
        "source": "example-feed",
        "sourceKey": "890",
        "url": "https://example.com/media/890",
        "metadata": {"author": "user"},
    })
    unsupported_download_response = machine.succeed(
        "curl --fail --silent --show-error "
        "-H 'content-type: application/json' "
        f"--data '{unsupported_download_payload}' "
        "http://127.0.0.1:8080/UrlMediaArchive/submitDiscoveredUrl"
    )
    unsupported_download_accepted = json.loads(unsupported_download_response)
    unsupported_download_status_payload = json.dumps({"source": "example-feed", "sourceKey": "890"})
    machine.wait_until_succeeds(
        "curl --fail --silent --show-error --max-time 5 "
        "-H 'content-type: application/json' "
        f"--data '{unsupported_download_status_payload}' "
        "http://127.0.0.1:8080/UrlMediaArchive/statusBySource | jq -e '.status == \"terminal_failed\" and .probeStatus == \"has_media\" and .error.type == \"terminal_unsupported_url\" and (.outputs | length) == 0'",
        timeout=60,
    )
    machine.succeed(f"test ! -d {temp_dir_for_job_key(unsupported_download_accepted['jobKey'])}")

    rate_limited_download_payload = json.dumps({
        "source": "example-feed",
        "sourceKey": "891",
        "url": "https://example.com/media/891",
        "metadata": {"author": "user"},
    })
    rate_limited_download_response = machine.succeed(
        "curl --fail --silent --show-error "
        "-H 'content-type: application/json' "
        f"--data '{rate_limited_download_payload}' "
        "http://127.0.0.1:8080/UrlMediaArchive/submitDiscoveredUrl"
    )
    rate_limited_download_accepted = json.loads(rate_limited_download_response)
    rate_limited_download_status_payload = json.dumps({"source": "example-feed", "sourceKey": "891"})
    machine.wait_until_succeeds(
        "curl --fail --silent --show-error --max-time 5 "
        "-H 'content-type: application/json' "
        f"--data '{rate_limited_download_status_payload}' "
        "http://127.0.0.1:8080/UrlMediaArchive/statusBySource | jq -e '.status == \"failed\" and .probeStatus == \"has_media\" and .nextRetryAt != null and .error.type == \"retryable_rate_limit\" and .error.retryable == true and .error.terminal == false and (.outputs | length) == 0'",
        timeout=60,
    )
    machine.succeed(f"test ! -d {temp_dir_for_job_key(rate_limited_download_accepted['jobKey'])}")

    retry_payload = json.dumps({
        "source": "example-feed",
        "sourceKey": "789",
        "url": "https://example.com/media/789",
        "metadata": {"author": "user"},
    })
    retry_response = machine.succeed(
        "curl --fail --silent --show-error "
        "-H 'content-type: application/json' "
        f"--data '{retry_payload}' "
        "http://127.0.0.1:8080/UrlMediaArchive/submitDiscoveredUrl"
    )
    retry_accepted = json.loads(retry_response)
    retry_status_payload = json.dumps({"source": "example-feed", "sourceKey": "789"})
    machine.wait_until_succeeds(
        "curl --fail --silent --show-error --max-time 5 "
        "-H 'content-type: application/json' "
        f"--data '{retry_status_payload}' "
        "http://127.0.0.1:8080/UrlMediaArchive/statusBySource | jq -e '.status == \"failed\" and .probeStatus == \"has_media\" and .nextRetryAt != null and .error.type == \"retryable_network_timeout\" and (.outputs | length) == 0'",
        timeout=60,
    )
    machine.succeed(f"test ! -d {temp_dir_for_job_key(retry_accepted['jobKey'])}")
  '';
}
