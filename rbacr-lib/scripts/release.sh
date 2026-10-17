#!/usr/bin/env bash
# Releases rbacr-lib (README "Release"): from an up-to-date main, checks
# it, packs rbacr-lib-<version>.tgz and publishes it as the GitHub release
# rbacr-lib-v<version> of prodbytes/rbacr, which apps install by URL. A
# version is released once: bump package.json's first.
set -euo pipefail

cd "$(dirname "$0")/.."
branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$branch" != main ]]; then
  echo "error: release from main (on $branch)" >&2
  exit 1
fi
git fetch -q origin main
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "error: main isn't origin/main; pull first" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain -- .)" ]]; then
  echo "error: rbacr-lib has uncommitted changes" >&2
  exit 1
fi
version="$(node -p 'require("./package.json").version')"
tag="rbacr-lib-v$version"
if gh release view "$tag" >/dev/null 2>&1; then
  echo "error: $tag is already released; bump package.json's version" >&2
  exit 1
fi
npm ci --no-audit --no-fund
npm run check
tarball="$(npm pack --silent)"
gh release create "$tag" "$tarball" --target "$(git rev-parse HEAD)" \
  --title "rbacr-lib $version" \
  --notes "Install: \`npm install https://github.com/prodbytes/rbacr/releases/download/$tag/$tarball\`"
rm -f "$tarball"
echo "released $tag: https://github.com/prodbytes/rbacr/releases/download/$tag/$tarball"
