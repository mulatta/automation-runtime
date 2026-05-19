{
  lib,
  mediaArchivePackage,
  pkgs,
  restatePackage,
}:
let
  restateConfig = (pkgs.formats.toml { }).generate "restate-keep-failed-temp-test.toml" {
    "base-dir" = "/var/lib/restate";
    "bind-address" = "127.0.0.1:5122";
    admin."bind-address" = "127.0.0.1:9070";
    ingress."bind-address" = "127.0.0.1:8080";
    worker.invoker."inactivity-timeout" = "0m";
  };
  fakeYtDlp = pkgs.writeShellScriptBin "yt-dlp" ''
    set -euo pipefail
    if [[ " $* " == *" --dump-single-json "* ]]; then
      cat <<'JSON'
    {"id":"456","title":"Expired cookie fixture","extractor":"test","webpage_url":"https://example.com/media/456","formats":[{"format_id":"http","url":"https://cdn.example.invalid/video.mp4"}]}
    JSON
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
      printf 'preserved failure temp\n' > "$target_dir/failure-marker.part"
      echo "ERROR: login required; cookie expired" >&2
      exit 1
    fi
    echo "unexpected URL" >&2
    exit 1
  '';
in
pkgs.testers.runNixOSTest {
  name = "media-archive-keep-failed-temp";

  nodes.machine =
    { ... }:
    {
      imports = [ ../nixosModules/media-archive.nix ];

      environment.systemPackages = [
        pkgs.curl
        pkgs.jq
        pkgs.postgresql
      ];

      services.restateWorkers.media-archive = {
        enable = true;
        package = mediaArchivePackage;
        restateAdminUrl = "http://127.0.0.1:9070";
        endpointUrl = "http://127.0.0.1:9080";
        ytDlpPackage = fakeYtDlp;
        keepFailedTempDirs = true;
      };

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
        return "/var/lib/media-archive/archive/.tmp/" + re.sub(r"[^A-Za-z0-9._-]", "_", job_key)

    machine.start()
    machine.wait_for_unit("postgresql.service")
    machine.wait_for_unit("restate.service")
    machine.wait_for_open_port(8080)
    machine.wait_for_open_port(9070)
    machine.wait_until_succeeds("systemctl show -p Result --value media-archive-worker-migrate.service | grep '^success$'")
    machine.wait_for_unit("media-archive-worker.service")
    machine.wait_for_open_port(9080)
    machine.wait_until_succeeds("systemctl show -p Result --value media-archive-worker-register.service | grep '^success$'")

    payload = json.dumps({
        "source": "example-feed",
        "sourceKey": "456",
        "url": "https://example.com/media/456",
        "metadata": {"author": "user"},
    })
    machine.wait_until_succeeds(
        "curl --fail --silent --show-error --max-time 5 "
        "-H 'content-type: application/json' "
        f"--data '{payload}' "
        "http://127.0.0.1:8080/MediaArchive/submitDiscoveredUrl > /tmp/accepted-456.json",
        timeout=60,
    )
    response = machine.succeed("cat /tmp/accepted-456.json")
    accepted = json.loads(response)
    status_payload = json.dumps({"source": "example-feed", "sourceKey": "456"})
    machine.wait_until_succeeds(
        "curl --fail --silent --show-error --max-time 5 "
        "-H 'content-type: application/json' "
        f"--data '{status_payload}' "
        "http://127.0.0.1:8080/MediaArchive/statusBySource | jq -e '.status == \"terminal_failed\" and .probeStatus == \"has_media\"'",
        timeout=60,
    )
    temp_dir = temp_dir_for_job_key(accepted["jobKey"])
    machine.succeed(f"test -f {temp_dir}/failure-marker.part")
  '';
}
