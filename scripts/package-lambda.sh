#!/usr/bin/env bash
# Packages the production build as the Lambda zip infra/app.yaml deploys:
# build/, lambda.js, package.json and the runtime dependencies only
# (npm ci --omit=dev), staged in .lambda/ and zipped to $OUT (default
# dist/rbacr-lambda.zip). Then runs the Lambda smoke test
# (tests/lambda.test.mjs) against the staged bundle, so a missing runtime
# dependency fails here rather than in AWS. Run `npm run build` first.
#   OUT         the zip to write (default dist/rbacr-lambda.zip)
#   SKIP_SMOKE  1 to skip the smoke test
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="${OUT:-dist/rbacr-lambda.zip}"
STAGE=.lambda

test -f build/handler.js || { echo "error: no build/; run npm run build first" >&2; exit 1; }

rm -rf "$STAGE"
mkdir -p "$STAGE" "$(dirname "$OUT")"
cp -R build lambda.js package.json package-lock.json "$STAGE/"
(cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent)

if [[ "${SKIP_SMOKE:-}" != 1 ]]; then
  mkdir -p "$STAGE/tests"
  cp tests/lambda.test.mjs "$STAGE/tests/"
  (cd "$STAGE" && node --test tests/lambda.test.mjs)
  rm -rf "$STAGE/tests"
fi

rm -f "$OUT"
out_abs="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
# The lock file only served npm ci; keep package.json ("type": "module").
(cd "$STAGE" && rm package-lock.json && zip -qr -X "$out_abs" .)
echo "package-lambda: wrote $OUT ($(du -h "$OUT" | cut -f1))"
