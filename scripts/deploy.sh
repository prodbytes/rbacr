#!/usr/bin/env bash
# Deploys rbacr to production, https://rbacr.nu01.com, or with STAGE=rc to
# the release candidate, https://rc.rbacr.nu01.com (its own stacks, rbacr-rc*):
#   1. builds the app and packages the Lambda zip (scripts/package-lambda.sh,
#      which smoke-tests it)
#   2. deploys the artifacts bucket (infra/artifacts.yaml, stack
#      rbacr[-rc]-artifacts) and uploads the zip
#   3. deploys the app (infra/app.yaml, stack rbacr[-rc]: certificate,
#      VPC, Aurora PostgreSQL Serverless v2 with its credentials in Secrets
#      Manager, Lambda + function URL, CloudFront, DNS, and the Route 53 health check
#      of /health with its e-mail alarm)
#   4. smoke-tests the live site: /health must be healthy and report this
#      version, /
#      must be the sign-in page, /api/me must refuse anonymous calls (401),
#      /login/dev must not exist (404), and the function URL must refuse
#      direct calls (403)
#
# Run by .github/workflows/deploy.yml (*GA tags) and deploy-rc.yml (*RC*
# tags), or by hand with admin credentials. Needs the AWS CLI, Node, zip and
# curl (all in devbox). Settings, from the environment, falling back to the
# git-ignored .env.$STAGE (e.g. .env.prod) for manual deploys; never from
# .env, which holds local development values:
#   TAG           the release tag, X.Y.Z-GA / X.Y.Z-RC: its X.Y must match
#                 the version files and its Z becomes the version's Z
#                 (default: none, so Z is the current time)
#   STAGE         prod (default) or rc
#   AWS_REGION    must be us-east-1 (CloudFront certificates live there)
#   SKIP_BUILD    1 to deploy an existing dist/rbacr-lambda.zip
#   HOSTED_ZONE_ID the rbacr.nu01.com zone (default: the rbacr-zone stack's output)
#   RBACR_ROOT_LIST   root addresses/domains; passed on every deploy, so
#                 the stack never keeps an old value (empty: no roots)
#   RBACR_GOOGLE_CLIENT_ID, RBACR_GOOGLE_CLIENT_SECRET
#                 required on the first deploy of a stage; afterwards, unset
#                 ones keep their deployed values
#   HEALTH_EMAILS comma-separated addresses the health alarm e-mails
#                 (default: the template's, on the first deploy; afterwards
#                 unset keeps the deployed value)
set -euo pipefail

cd "$(dirname "$0")/.."
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_DEFAULT_REGION="$AWS_REGION"
if [[ "$AWS_REGION" != us-east-1 ]]; then
  echo "error: deploy to us-east-1 (CloudFront certificates live there), not $AWS_REGION" >&2
  exit 2
fi
STAGE="${STAGE:-prod}"
case "$STAGE" in
  prod) STACK=rbacr; DOMAIN=rbacr.nu01.com; DB_MAX_ACU=4 ;;
  rc) STACK=rbacr-rc; DOMAIN=rc.rbacr.nu01.com; DB_MAX_ACU=2 ;;
  *) echo "error: STAGE must be prod or rc (got '$STAGE')" >&2; exit 2 ;;
esac
ARTIFACTS_STACK=$STACK-artifacts

# Read KEY=value lines (not sourced, so nothing in it runs); the environment wins.
if [[ -f ".env.$STAGE" ]]; then
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^(RBACR_[A-Z_]+|HEALTH_EMAILS|HOSTED_ZONE_ID)$ ]] || continue
    [[ -n "${!key:-}" ]] || export "$key=$value"
  done < ".env.$STAGE"
fi

if [[ "${TAG:-}" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)(-.*)?$ ]]; then
  export VERSION_Z="${BASH_REMATCH[3]}"
  tag_xy="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"
elif [[ -n "${TAG:-}" ]]; then
  echo "error: TAG '$TAG' isn't X.Y.Z[-suffix]" >&2
  exit 2
fi
source scripts/version.sh
if [[ -n "${tag_xy:-}" && "$tag_xy" != "$VERSION_X.$VERSION_Y" ]]; then
  echo "error: tag $TAG is version $tag_xy, but version.X.txt/version.Y.txt say $VERSION_X.$VERSION_Y" >&2
  exit 1
fi
# The deployed version: the tag when there is one (it names the release).
RELEASE="${TAG:-$VERSION}"
echo "==> deploying $RELEASE to https://$DOMAIN/ ($STAGE, $AWS_REGION)"

stack_output() { # stack_output <stack> <output key>
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}
stack_exists() {
  aws cloudformation describe-stacks --stack-name "$1" >/dev/null 2>&1
}

if [[ -z "${HOSTED_ZONE_ID:-}" ]]; then
  HOSTED_ZONE_ID="$(stack_output rbacr-zone HostedZoneId 2>/dev/null || true)"
fi
[[ "$HOSTED_ZONE_ID" =~ ^Z[A-Z0-9]+$ ]] || {
  echo "error: HOSTED_ZONE_ID isn't set (environment, or the rbacr-zone stack; see infra/README.md)" >&2
  exit 1
}
if [[ ! "${HEALTH_EMAILS:-}" =~ ^[A-Za-z0-9._%+@,-]*$ ]]; then
  echo "error: HEALTH_EMAILS must be comma-separated addresses" >&2
  exit 1
fi
if [[ ! "${RBACR_ROOT_LIST:-}" =~ ^[A-Za-z0-9._%+@,\ -]*$ ]]; then
  echo "error: RBACR_ROOT_LIST must be comma-separated addresses or domains" >&2
  exit 1
fi

# The parameters: settings that are set override; unset secrets keep their
# deployed values, but a stage's first deploy needs all of them.
params=("DomainName=$DOMAIN" "HostedZoneId=$HOSTED_ZONE_ID" "Version=$RELEASE"
  "RootList=${RBACR_ROOT_LIST:-}" "DbMaxCapacity=$DB_MAX_ACU")
first_deploy=true; stack_exists "$STACK" && first_deploy=false
for pair in GoogleClientId:RBACR_GOOGLE_CLIENT_ID GoogleClientSecret:RBACR_GOOGLE_CLIENT_SECRET; do
  param="${pair%%:*}" name="${pair#*:}"
  if [[ -n "${!name:-}" ]]; then
    params+=("$param=${!name}")
  elif $first_deploy; then
    echo "error: $name must be set for the first deploy of $STACK" >&2
    exit 1
  fi
done
[[ -n "${HEALTH_EMAILS:-}" ]] && params+=("HealthNotificationEmails=$HEALTH_EMAILS")
# Addresses are people's: logged only as a count.
roots=0; [[ -n "${RBACR_ROOT_LIST:-}" ]] && roots=$(tr ',' '\n' <<<"$RBACR_ROOT_LIST" | grep -c .)
echo "    root allow list: $roots entr(ies)"

# 1. Build and package
zip=dist/rbacr-lambda.zip
if [[ "${SKIP_BUILD:-}" != 1 ]]; then
  echo "==> building"
  npm ci --no-audit --no-fund
  npm run build
  OUT="$zip" bash scripts/package-lambda.sh
fi
test -f "$zip" || { echo "error: no $zip" >&2; exit 1; }

# 2. Artifacts
echo "==> deploying $ARTIFACTS_STACK"
aws cloudformation deploy --stack-name "$ARTIFACTS_STACK" \
  --template-file infra/artifacts.yaml --no-fail-on-empty-changeset
bucket="$(stack_output "$ARTIFACTS_STACK" ArtifactsBucketName)"
key="lambda/rbacr-$RELEASE-$(git rev-parse --short HEAD 2>/dev/null || echo local)-$BUILD_NUMBER.zip"
aws s3 cp "$zip" "s3://$bucket/$key" --only-show-errors
echo "    code: s3://$bucket/$key"

# 3. The app
echo "==> deploying $STACK"
aws cloudformation deploy --stack-name "$STACK" \
  --template-file infra/app.yaml --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND \
  --parameter-overrides "${params[@]}" "CodeBucket=$bucket" "CodeKey=$key" \
  --no-fail-on-empty-changeset
function_url="$(stack_output "$STACK" FunctionUrl)"

# 4. Smoke test (retried: on a first deploy DNS and the edge take a moment)
echo "==> checking https://$DOMAIN/"
status() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }
check() {
  local health
  health="$(curl -fsS --max-time 20 "https://$DOMAIN/health")" || { echo "    /health failed"; return 1; }
  [[ "$health" == "{\"ok\":true,\"version\":\"$RELEASE\",\"checks\":{\"database\":\"ok\",\"google\":\"ok\"}}" ]] \
    || { echo "    /health says $health, want healthy and version $RELEASE"; return 1; }
  curl -fsS --max-time 20 -H 'accept: text/html' "https://$DOMAIN/" | grep -q 'Sign in with Google' \
    || { echo "    / isn't the sign-in page"; return 1; }
  local code
  code="$(status "https://$DOMAIN/api/me")"; [[ "$code" == 401 ]] || { echo "    /api/me answered $code, want 401"; return 1; }
  code="$(status -H 'accept: text/html' "https://$DOMAIN/login/dev")"; [[ "$code" == 404 ]] || { echo "    /login/dev answered $code, want 404"; return 1; }
  code="$(status "${function_url%/}/health")"; [[ "$code" == 403 ]] || { echo "    the function URL answered $code, want 403"; return 1; }
}
for attempt in $(seq 1 30); do
  if check; then
    echo "==> https://$DOMAIN/ serves $RELEASE"
    exit 0
  fi
  echo "    not yet (attempt $attempt/30); retrying in 20 s"
  sleep 20
done
echo "error: https://$DOMAIN/ didn't serve $RELEASE" >&2
exit 1
