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

          urlMediaArchive = mkWorker {
            pname = "url-media-archive";
            workspace = "@restate-workflows/url-media-archive";
            binName = "url-media-archive-worker";
            mainFile = "dist/src/main.js";
            description = "Generic Restate worker for archiving URLs to filesystem storage";
          };

          packages = {
            default = urlMediaArchive;
            url-media-archive = urlMediaArchive;
          };

          urlMediaArchiveReplayTest = pkgs.callPackage ./tests/url-media-archive-replay.nix {
            urlMediaArchivePackage = urlMediaArchive;
            restatePackage = unfreePkgs.restate;
          };

          urlMediaArchiveKeepFailedTempTest =
            pkgs.callPackage ./tests/url-media-archive-keep-failed-temp.nix
              {
                urlMediaArchivePackage = urlMediaArchive;
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
            urlMediaArchiveKeepFailedTempTest
            urlMediaArchiveReplayTest
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
          url-media-archive-keep-failed-temp = perSystem.${system}.urlMediaArchiveKeepFailedTempTest;
          url-media-archive-replay = perSystem.${system}.urlMediaArchiveReplayTest;
        }
      );

      formatter = eachSystem ({ system, ... }: treefmtEval.${system}.config.build.wrapper);

      nixosModules = {
        default = ./nixosModules;
        url-media-archive = ./nixosModules/url-media-archive.nix;
      };
    };
}
