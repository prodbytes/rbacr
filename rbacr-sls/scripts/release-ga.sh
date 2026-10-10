#!/usr/bin/env bash
# Tags the current commit, which must be on main, as a general-availability
# release, X.Y.Z-GA (Z is the current time), and pushes it: the Release
# workflow publishes it as the latest release and Deploy deploys it to
# https://rbacr.nu01.com. DRY_RUN=1 only prints the tag. See
# scripts/tag-release.sh.
set -euo pipefail
exec bash "$(dirname "$0")/tag-release.sh" GA
