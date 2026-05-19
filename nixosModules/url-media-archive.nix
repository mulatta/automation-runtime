{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.restateWorkers.url-media-archive;
  dbCfg = cfg.database;

  localDatabaseUrl = "postgresql:///${dbCfg.name}?host=/run/postgresql&user=${dbCfg.user}";
  endpointBaseUrl = lib.removeSuffix "/" cfg.endpointUrl;
  workerHealthUrl = "${endpointBaseUrl}/health";
  cookieDir = lib.optionalString (cfg.cookiePath != null) (builtins.dirOf cfg.cookiePath);
  databaseEnv = lib.optionalString (dbCfg.urlFile == null && dbCfg.createLocally) ''
    URL_MEDIA_ARCHIVE_DATABASE_URL=${lib.escapeShellArg localDatabaseUrl}
  '';
  envFile = pkgs.writeText "url-media-archive-worker.env" ''
    URL_MEDIA_ARCHIVE_HOST=${lib.escapeShellArg cfg.host}
    URL_MEDIA_ARCHIVE_PORT=${toString cfg.port}
    URL_MEDIA_ARCHIVE_ROOT=${lib.escapeShellArg cfg.archiveRoot}
    URL_MEDIA_ARCHIVE_RESTATE_IDENTITY_KEYS=${lib.escapeShellArg (lib.concatStringsSep "," cfg.requestIdentity.publicKeys)}
    URL_MEDIA_ARCHIVE_YTDLP_BINARY=${lib.escapeShellArg (lib.getExe cfg.ytDlpPackage)}
    URL_MEDIA_ARCHIVE_YTDLP_PROBE_TIMEOUT_MS=${toString cfg.ytDlpProbeTimeoutMs}
    URL_MEDIA_ARCHIVE_YTDLP_DOWNLOAD_TIMEOUT_MS=${toString cfg.ytDlpDownloadTimeoutMs}
    URL_MEDIA_ARCHIVE_YTDLP_PROBE_CONCURRENCY=${toString cfg.ytDlpProbeConcurrency}
    URL_MEDIA_ARCHIVE_YTDLP_DOWNLOAD_CONCURRENCY=${toString cfg.ytDlpDownloadConcurrency}
    URL_MEDIA_ARCHIVE_YTDLP_REQUEST_MIN_INTERVAL_MS=${toString cfg.ytDlpRequestMinIntervalMs}
    URL_MEDIA_ARCHIVE_KEEP_FAILED_TEMP_DIRS=${lib.boolToString cfg.keepFailedTempDirs}
    ${databaseEnv}
  '';
  workerEnvironment =
    cfg.extraEnvironment
    // lib.optionalAttrs (cfg.cookiePath != null) {
      URL_MEDIA_ARCHIVE_COOKIE_PATH = cfg.cookiePath;
    }
    // lib.optionalAttrs (dbCfg.urlFile != null) {
      URL_MEDIA_ARCHIVE_DATABASE_URL_FILE = "%d/database-url";
    };
  databaseCredential = lib.optionals (dbCfg.urlFile != null) [
    "database-url:${toString dbCfg.urlFile}"
  ];
  localDatabaseUnits = lib.optionals dbCfg.createLocally [
    "postgresql.service"
    "postgresql-setup.service"
  ];
  migrationUnits = lib.optionals cfg.runMigrations [
    "url-media-archive-worker-migrate.service"
  ];
in
{
  options.services.restateWorkers.url-media-archive = {
    enable = lib.mkEnableOption "generic URL media archive Restate worker";

    package = lib.mkOption {
      type = lib.types.package;
      description = "Package providing the url-media-archive-worker executable.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "url-media-archive";
      description = "User that runs the worker.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "url-media-archive";
      description = "Group that runs the worker.";
    };

    supplementaryGroups = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Additional groups for reading shared inputs.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Local address the worker endpoint binds to.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 9080;
      description = "Worker HTTP port.";
    };

    endpointUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://127.0.0.1:9080";
      description = "URL registered with Restate for this deployment.";
    };

    restateAdminUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://127.0.0.1:9070";
      description = "Restate Admin API URL used for deployment registration.";
    };

    registerDeployment = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Register the worker endpoint with Restate Admin API after startup.";
    };

    runMigrations = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Run the URL media archive database migration oneshot before starting the worker.";
    };

    requestIdentity.publicKeys = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Restate request identity public keys allowed to invoke the worker endpoint. When set, Restate Server must sign service requests with the matching private key.";
    };

    database = {
      createLocally = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Create a local PostgreSQL database owned by the worker.";
      };

      name = lib.mkOption {
        type = lib.types.str;
        default = "url-media-archive";
        description = "Local PostgreSQL database name for archive catalog tables. Must match database.user when createLocally is enabled because local peer auth is used.";
      };

      user = lib.mkOption {
        type = lib.types.str;
        default = "url-media-archive";
        description = "Local PostgreSQL role that owns the archive database.";
      };

      urlFile = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        default = null;
        description = "Optional credential file containing the Postgres connection URL. Overrides local database URL env.";
      };
    };

    ytDlpPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.yt-dlp;
      defaultText = lib.literalExpression "pkgs.yt-dlp";
      description = "Package providing the yt-dlp executable used for probing and downloads.";
    };

    ytDlpProbeTimeoutMs = lib.mkOption {
      type = lib.types.ints.positive;
      default = 120000;
      description = "Timeout in milliseconds for yt-dlp metadata probes.";
    };

    ytDlpDownloadTimeoutMs = lib.mkOption {
      type = lib.types.ints.positive;
      default = 900000;
      description = "Timeout in milliseconds for yt-dlp downloads.";
    };

    ytDlpProbeConcurrency = lib.mkOption {
      type = lib.types.ints.positive;
      default = 2;
      description = "Maximum number of concurrent yt-dlp metadata probe processes in this worker.";
    };

    ytDlpDownloadConcurrency = lib.mkOption {
      type = lib.types.ints.positive;
      default = 2;
      description = "Maximum number of concurrent yt-dlp download processes in this worker.";
    };

    ytDlpRequestMinIntervalMs = lib.mkOption {
      type = lib.types.ints.unsigned;
      default = 0;
      description = "Minimum milliseconds between yt-dlp requests for the same URL hostname. Zero disables durable host throttling.";
    };

    keepFailedTempDirs = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Keep failed download temp directories for debugging.";
    };

    cookiePath = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/var/lib/url-media-archive/cookies/browser.netscape.txt";
      description = "Optional yt-dlp Netscape cookie jar path. The module only passes this path to the worker and grants systemd write access to its directory; create and refresh the file out of band.";
    };

    archiveRoot = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/url-media-archive/archive";
      description = "Filesystem root for archived media.";
    };

    extraEnvironment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Additional environment variables for the worker.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = !dbCfg.createLocally || dbCfg.name == dbCfg.user;
        message = "services.restateWorkers.url-media-archive.database.name must match database.user when createLocally is enabled.";
      }
    ];

    users.users.${cfg.user} = {
      isSystemUser = true;
      inherit (cfg) group;
    };
    users.groups.${cfg.group} = { };

    services.postgresql = lib.mkIf dbCfg.createLocally {
      enable = true;
      ensureDatabases = [ dbCfg.name ];
      ensureUsers = [
        {
          name = dbCfg.user;
          ensureDBOwnership = true;
        }
      ];
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.archiveRoot} 0750 ${cfg.user} ${cfg.group} -"
    ];

    systemd.services.url-media-archive-worker-migrate = lib.mkIf cfg.runMigrations {
      description = "Migrate URL media archive database";
      after = localDatabaseUnits;
      requires = localDatabaseUnits;

      environment = workerEnvironment;

      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${lib.getExe cfg.package} migrate";
        EnvironmentFile = envFile;
        User = cfg.user;
        Group = cfg.group;
        LoadCredential = databaseCredential;

        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectHome = true;
        ProtectSystem = "strict";
      };
    };

    systemd.services.url-media-archive-worker = {
      description = "URL media archive Restate worker";
      wantedBy = [ "multi-user.target" ];
      after = [
        "network-online.target"
      ]
      ++ localDatabaseUnits
      ++ migrationUnits;
      wants = [
        "network-online.target"
      ];
      requires = localDatabaseUnits ++ migrationUnits;

      environment = workerEnvironment;

      serviceConfig = {
        ExecStart = "${lib.getExe cfg.package}";
        EnvironmentFile = envFile;
        User = cfg.user;
        Group = cfg.group;
        SupplementaryGroups = cfg.supplementaryGroups;
        DynamicUser = false;
        StateDirectory = "url-media-archive-worker";
        CacheDirectory = "url-media-archive-worker";
        ReadWritePaths = [ cfg.archiveRoot ] ++ lib.optionals (cfg.cookiePath != null) [ cookieDir ];
        Restart = "always";
        RestartSec = "5s";
        TasksMax = 64;

        LoadCredential = databaseCredential;

        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        ProtectClock = true;
        ProtectControlGroups = true;
        ProtectHome = true;
        ProtectHostname = true;
        ProtectKernelLogs = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        ProtectProc = "invisible";
        ProtectSystem = "strict";
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        SystemCallArchitectures = "native";
      };
    };

    systemd.services.url-media-archive-worker-register = lib.mkIf cfg.registerDeployment {
      description = "Register URL media archive worker with Restate";
      wantedBy = [ "multi-user.target" ];
      after = [
        "restate.service"
        "url-media-archive-worker.service"
      ];
      wants = [
        "restate.service"
        "url-media-archive-worker.service"
      ];

      path = [ pkgs.curl ];

      script = ''
        set -euo pipefail

        for attempt in $(seq 1 60); do
          if curl --http2-prior-knowledge --fail --silent --show-error --max-time 2 \
            ${lib.escapeShellArg workerHealthUrl} >/dev/null; then
            break
          fi
          if [ "$attempt" -eq 60 ]; then
            echo "URL media archive worker endpoint did not become healthy: ${workerHealthUrl}" >&2
            exit 1
          fi
          sleep 1
        done

        for attempt in $(seq 1 60); do
          if curl --fail --silent --show-error --max-time 2 \
            ${lib.escapeShellArg cfg.restateAdminUrl}/deployments \
            --json ${
              lib.escapeShellArg (
                builtins.toJSON {
                  uri = cfg.endpointUrl;
                  force = true;
                }
              )
            }; then
            exit 0
          fi
          if [ "$attempt" -eq 60 ]; then
            echo "failed to register Restate deployment: ${cfg.endpointUrl}" >&2
            exit 1
          fi
          sleep 1
        done
      '';

      serviceConfig = {
        Type = "oneshot";
        User = cfg.user;
        Group = cfg.group;
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
      };
    };
  };
}
