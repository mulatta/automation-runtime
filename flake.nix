{
  description = "Restate Workflows & Workers";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      treefmt-nix,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      inherit (nixpkgs) lib;

      eachSystem =
        f:
        lib.genAttrs systems (
          system:
          f {
            inherit system;
            pkgs = nixpkgs.legacyPackages.${system};
          }
        );

      perSystem = eachSystem (
        { pkgs, system, ... }:
        let
          npmDeps = pkgs.importNpmLock {
            npmRoot = ./.;
          };

          unfreePkgs = import nixpkgs {
            inherit system;
            config.allowUnfreePredicate = pkg: lib.getName pkg == "restate";
          };

          restateDocs = pkgs.stdenvNoCC.mkDerivation {
            pname = "restate-docs";
            version = "0.1.0";

            src = ./tools/restate-docs;
            dontBuild = true;

            nativeBuildInputs = [ pkgs.makeWrapper ];

            installPhase = ''
              runHook preInstall
              install -Dm644 main.py $out/share/restate-docs/main.py
              makeWrapper ${pkgs.python3}/bin/python3 $out/bin/restate-docs \
                --add-flags "$out/share/restate-docs/main.py"
              runHook postInstall
            '';
          };

          mkWorker =
            {
              pname,
              workspace,
              binName,
              mainFile,
              description,
            }:
            pkgs.buildNpmPackage {
              inherit pname;
              version = "0.1.0";

              src = lib.fileset.toSource {
                root = ./.;
                fileset = lib.fileset.unions [
                  ./eslint.config.js
                  ./jest.config.js
                  ./package.json
                  ./package-lock.json
                  ./packages
                  ./tsconfig.base.json
                  ./tsconfig.json
                ];
              };

              inherit npmDeps;
              inherit (pkgs.importNpmLock) npmConfigHook;

              nativeBuildInputs = [ pkgs.makeWrapper ];
              makeCacheWritable = true;
              npmFlags = [
                "--ignore-scripts"
                "--legacy-peer-deps"
              ];

              buildPhase = ''
                runHook preBuild
                npm run build --workspaces --if-present
                runHook postBuild
              '';

              doCheck = true;
              checkPhase = ''
                runHook preCheck
                npm test -- --runInBand
                runHook postCheck
              '';

              installPhase = ''
                runHook preInstall

                npm prune --omit=dev --legacy-peer-deps

                nodeDir="$out/lib/node_modules/${workspace}"
                mkdir -p "$nodeDir"
                cp -r packages/${pname}/dist packages/${pname}/package.json node_modules "$nodeDir"/
                find "$nodeDir/node_modules" -type l -xtype l -delete

                makeWrapper ${pkgs.nodejs}/bin/node "$out/bin/${binName}" \
                  --add-flags "$nodeDir/${mainFile}"

                runHook postInstall
              '';

              meta = {
                inherit description;
                license = lib.licenses.mit;
                mainProgram = binName;
              };
            };

          mediaArchive = mkWorker {
            pname = "media-archive";
            workspace = "@restate-workflows/media-archive";
            binName = "media-archive-worker";
            mainFile = "dist/src/main.js";
            description = "Generic Restate worker for archiving URLs to filesystem storage";
          };

          packages = {
            default = mediaArchive;
            media-archive = mediaArchive;
          };

          mediaArchiveReplayTest = pkgs.callPackage ./tests/media-archive-replay.nix {
            mediaArchivePackage = mediaArchive;
            restatePackage = unfreePkgs.restate;
          };

          mediaArchiveKeepFailedTempTest = pkgs.callPackage ./tests/media-archive-keep-failed-temp.nix {
            mediaArchivePackage = mediaArchive;
            restatePackage = unfreePkgs.restate;
          };

          devShell = pkgs.mkShell {
            packages = [
              pkgs.nodejs
              pkgs.python3
              restateDocs
            ];
          };
        in
        {
          inherit
            packages
            devShell
            mediaArchiveKeepFailedTempTest
            mediaArchiveReplayTest
            ;
        }
      );

      treefmtEval = eachSystem (
        { pkgs, ... }:
        treefmt-nix.lib.evalModule pkgs {
          projectRootFile = "flake.nix";
          programs = {
            deadnix.enable = true;
            keep-sorted.enable = true;
            nixfmt.enable = true;
            prettier.enable = true;
            statix.enable = true;
          };
          settings.formatter.prettier.excludes = [
            "flake.lock"
            "package-lock.json"
          ];
        }
      );
    in
    {
      packages = eachSystem ({ system, ... }: perSystem.${system}.packages);

      devShells = eachSystem (
        { system, ... }:
        {
          default = perSystem.${system}.devShell;
        }
      );

      checks = eachSystem (
        { system, ... }:
        perSystem.${system}.packages
        // {
          devShell = perSystem.${system}.devShell;
          treefmt = treefmtEval.${system}.config.build.check self;
        }
        // lib.optionalAttrs (system == "x86_64-linux") {
          media-archive-keep-failed-temp = perSystem.${system}.mediaArchiveKeepFailedTempTest;
          media-archive-replay = perSystem.${system}.mediaArchiveReplayTest;
        }
      );

      formatter = eachSystem ({ system, ... }: treefmtEval.${system}.config.build.wrapper);

      nixosModules = {
        default = ./nixosModules;
        media-archive = ./nixosModules/media-archive.nix;
      };
    };
}
