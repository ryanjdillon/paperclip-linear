{
  description = "paperclip-linear - Paperclip plugin that makes Linear the source of truth";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        # Toolchains only. package.json and pnpm-lock.yaml declare the dependencies.
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_24
            pnpm
            just
            prek
            python3
          ];
        };

        formatter = pkgs.nixfmt-rfc-style;
      }
    );
}
