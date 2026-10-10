# rbacr

A role manager for your applications: it records which roles each identity
(e-mail address or whole domain) holds in each system, and serves them as
web pages and as JSON.

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/prodbytes/rbacr)
[![Open in Dev Containers](https://img.shields.io/static/v1?label=Dev%20Containers&message=Open&color=007ACC&logo=visualstudiocode)](https://vscode.dev/redirect?url=vscode://ms-vscode-remote.remote-containers/cloneInVolume?url=https://github.com/prodbytes/rbacr)

## Components

| Folder | What it is |
|--------|------------|
| [rbacr-sls/](rbacr-sls/README.md) | The rbacr service: a SvelteKit app on AWS Lambda (serverless), with its spec ([SPEC.md](rbacr-sls/SPEC.md)), infrastructure, scripts and tests. Deployed to https://rbacr.nu01.com. |
| [rbacr-flutter/](rbacr-flutter/README.md) | The Dart client (package `rbacr`) for Flutter apps and Dart servers: role checks, with how long a "yes" holds, and voucher redemption, instead of raw HTTP calls. |
| [rbacr-lib/](rbacr-lib/README.md) | A client library for applications that ask rbacr about roles, caching role grants. Not specified yet. |

Each component is self-contained: work from its folder (for the service,
`cd rbacr-sls && devbox shell`). The GitHub workflows in
[.github/workflows/](.github/workflows/) and the dev container stay at the
repository root.

## Dev container

The toolchain is pinned by [devbox.json](rbacr-sls/devbox.json) and locked in
[devbox.lock](rbacr-sls/devbox.lock): Node.js, AWS CLI, mkcert, plus Python,
Go and GraalVM CE (musl, Linux only). The container also ships the
[docker-in-docker feature](https://github.com/devcontainers/features/tree/main/src/docker-in-docker),
so `docker ps` works out of the box.

The [Containerfile](.devcontainer/Containerfile) keeps the Microsoft
`ubuntu-24.04` devcontainer base image and layers Devbox on top:

1. Devbox is installed as root. Everything else runs as the `vscode` user, so
   the Nix store ownership matches the container's `remoteUser`.
2. Nix is installed in single-user mode (`--no-daemon`). Containers have no
   systemd, so the multi-user Nix daemon can't run.
3. At build time, the locked store paths are fetched straight from
   `cache.nixos.org` to warm `/nix/store`. This avoids GitHub API calls, so
   builds don't hit unauthenticated rate limits.
4. On container start, `postCreateCommand` runs `devbox install` in
   `rbacr-sls/`, which finds
   the heavy downloads already cached. The first install still evaluates
   nixpkgs, which takes a few minutes; after that the environment is instant.
5. Then [scripts/local-env.sh](rbacr-sls/scripts/local-env.sh) writes `.env` from the
   `RBACR_LOCAL_*` Codespaces secrets (`RBACR_LOCAL_<NAME>` becomes
   `RBACR_<NAME>`), unless `.env` already exists. The GA and RC tenants
   have their own `RBACR_GA_*` and `RBACR_RC_*` repository settings, used by
   the deploy workflows ([infra/README.md](rbacr-sls/infra/README.md#one-time-setup)).
