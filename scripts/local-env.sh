#!/usr/bin/env bash
# Writes .env for local development from the LOCAL tenant's settings,
# RBACR_LOCAL_<NAME> -> RBACR_<NAME>. In GitHub Codespaces these are
# Codespaces secrets (`gh secret set --app codespaces RBACR_LOCAL_…`), which
# arrive as environment variables. Leaves an existing .env alone and does
# nothing when no RBACR_LOCAL_* variable is set. Run by the devcontainer's
# postCreateCommand; values are never printed.
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ -e .env ]]; then
  echo ".env exists; leaving it as it is"
  exit 0
fi
mapfile -t names < <(compgen -e | grep '^RBACR_LOCAL_' || true)
if (( ${#names[@]} == 0 )); then
  echo "no RBACR_LOCAL_* settings; copy .env.example to .env to configure"
  exit 0
fi
umask 077
{
  echo "# Written by scripts/local-env.sh from RBACR_LOCAL_* settings. Never commit."
  for name in "${names[@]}"; do
    printf 'RBACR_%s=%s\n' "${name#RBACR_LOCAL_}" "${!name}"
  done
} > .env
echo "wrote .env from ${#names[@]} RBACR_LOCAL_* setting(s): ${names[*]}"
