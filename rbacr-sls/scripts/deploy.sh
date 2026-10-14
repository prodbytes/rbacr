#!/usr/bin/env bash
# Deploys rbacr to production, https://rbacr.nu01.com, or with STAGE=rc to
# the release candidate, https://rc.rbacr.nu01.com (its own stacks, rbacr-rc*):
#   1. builds the app and packages the Lambda zip (scripts/package-lambda.sh,
#      which smoke-tests it)
#   2. deploys the artifacts bucket (infra/artifacts.yaml, stack
#      rbacr[-rc]-artifacts) and uploads the zip, and the DynamoDB tables
#      (infra/tables.yaml, stack rbacr[-rc]-tables, tables rbacr[-rc] and
#      rbacr[-rc]-sessions)
#   3. deploys the app (infra/app.yaml, stack rbacr[-rc]: certificate,
#      validated in the nu01.com zone, Lambda + function URL, CloudFront, and
#      the function alarms with their e-mail topic; the DNS aliases belong to
#      the nu01-dns stack in the nu01 repository), with the origin secret
#      from the SSM parameter /rbacr/<stage>/origin-secret (created here on a stage's first deploy)
#   4. smoke-tests the live site: /health must be healthy and report this
#      version, / must be the sign-in page, /api/me must refuse anonymous
#      calls and unknown tokens (401; the latter is looked up in DynamoDB),
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
#   RBACR_ROOT_LIST   root addresses/domains (default @nu01.com); passed on
#                 every deploy, so the stack never keeps an old value
#   RBACR_GOOGLE_CLIENT_ID, RBACR_GOOGLE_CLIENT_SECRET
#                 required on the first deploy of a stage; afterwards, unset
#                 ones keep their deployed values
#   RBACR_GOOGLE_AUDIENCES  comma-separated Google OAuth client ids whose
#                 users' ID tokens /api accepts (SPEC I1-I5); empty or unset
#                 turns them off. Passed on every deploy, like the root list.
#   RBACR_TRUSTED_ISSUERS  OIDC issuers besides Google whose ID tokens /api
#                 accepts (SPEC I7-I9): a JSON array of {"issuer", "jwks",
#                 "audiences"}; empty or unset: none. Passed on every deploy.
#   RBACR_CORS_ORIGINS  comma-separated web origins allowed to call /api from
#                 the browser (SPEC H3, H4); empty or unset: no CORS. Passed
#                 on every deploy.
#   RBACR_STRIPE_WEBHOOK_SECRET, RBACR_STRIPE_API_KEY
#                 optional (the paid-subscription sync); unset ones keep
#                 their deployed values
#   HEALTH_EMAILS comma-separated addresses the function alarms e-mail
#                 (default julio+health@nu01.com); passed on every deploy,
#                 because the template's Fn::ForEach can't see defaults
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
  prod) STACK=rbacr; DOMAIN=rbacr.nu01.com; TENANCY=GA ;;
  rc) STACK=rbacr-rc; DOMAIN=rc.rbacr.nu01.com; TENANCY=RC ;;
  *) echo "error: STAGE must be prod or rc (got '$STAGE')" >&2; exit 2 ;;
esac
ARTIFACTS_STACK=$STACK-artifacts
TABLES_STACK=$STACK-tables
# Cost-allocation tags; CloudFormation copies them to every taggable resource.
TAGS=(project=rbacr "tenancy=$TENANCY")

# Read KEY=value lines (not sourced, so nothing in it runs); the environment wins.
if [[ -f ".env.$STAGE" ]]; then
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^(RBACR_[A-Z_]+|HEALTH_EMAILS)$ ]] || continue
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

# The certificate validates in the nu01.com zone (the nu01 repository's
# nu01-route53-zone stack); the retired rbacr.nu01.com subzone is no longer
# used (infra/README.md, "Zone merge"). A different value replaces the
# certificate.
VALIDATION_ZONE_ID=Z04838091YTBIM6PNI1XK
# This release deletes the stage's aliases from the subzone, so nu01.com must
# no longer delegate to it (round 1 of the zone merge, nu01 repository). The
# 48 hours after round 1 can't be checked here: see infra/README.md.
delegation="$(aws route53 list-resource-record-sets --hosted-zone-id "$VALIDATION_ZONE_ID" \
  --start-record-name rbacr.nu01.com --start-record-type NS --max-items 1 \
  --query "ResourceRecordSets[?Name=='rbacr.nu01.com.' && Type=='NS'].Name" --output text)"
if [[ -n "$delegation" ]]; then
  echo "error: nu01.com still delegates rbacr.nu01.com; run round 1 of the zone merge (nu01 repository) and wait 48 hours (infra/README.md)" >&2
  exit 1
fi
if [[ ! "${HEALTH_EMAILS:-}" =~ ^[A-Za-z0-9._%+@,-]*$ ]]; then
  echo "error: HEALTH_EMAILS must be comma-separated addresses" >&2
  exit 1
fi
# An unset or empty list (e.g. a missing repository variable) means the
# default, never "no roots".
RBACR_ROOT_LIST="${RBACR_ROOT_LIST:-@nu01.com}"
if [[ ! "${RBACR_ROOT_LIST:-}" =~ ^[A-Za-z0-9._%+@,\ -]*$ ]]; then
  echo "error: RBACR_ROOT_LIST must be comma-separated addresses or domains" >&2
  exit 1
fi
if [[ ! "${RBACR_GOOGLE_AUDIENCES:-}" =~ ^[A-Za-z0-9._,\ -]*$ ]]; then
  echo "error: RBACR_GOOGLE_AUDIENCES must be comma-separated Google OAuth client ids" >&2
  exit 1
fi
# Compacted to one line (a repository variable may hold pretty-printed JSON);
# the app checks the rest when it starts (SPEC I7), and the smoke test below
# would catch it not starting.
if [[ -n "${RBACR_TRUSTED_ISSUERS:-}" ]]; then
  RBACR_TRUSTED_ISSUERS="$(node -e '
    const v = JSON.parse(process.argv[1]);
    if (!Array.isArray(v)) throw new Error("not an array");
    process.stdout.write(JSON.stringify(v));' "$RBACR_TRUSTED_ISSUERS" 2>/dev/null)" || {
    echo "error: RBACR_TRUSTED_ISSUERS must be a JSON array of {\"issuer\", \"jwks\", \"audiences\"} objects" >&2
    exit 1
  }
fi
trusted_issuers_re='^[][A-Za-z0-9._~%:/?=&+,"@{} -]*$'
if [[ ! "${RBACR_TRUSTED_ISSUERS:-}" =~ $trusted_issuers_re ]]; then
  echo "error: RBACR_TRUSTED_ISSUERS has characters the app stack's TrustedIssuers parameter refuses" >&2
  exit 1
fi
if [[ ! "${RBACR_CORS_ORIGINS:-}" =~ ^[A-Za-z0-9.:/,\ -]*$ ]]; then
  echo "error: RBACR_CORS_ORIGINS must be comma-separated origins like https://app.example.com" >&2
  exit 1
fi

# The parameters: settings that are set override; unset secrets keep their
# deployed values, but a stage's first deploy needs all of them.
params=("DomainName=$DOMAIN" "ValidationZoneId=$VALIDATION_ZONE_ID" "Version=$RELEASE"
  "RootList=${RBACR_ROOT_LIST:-}"
  "GoogleAudiences=${RBACR_GOOGLE_AUDIENCES:-}" "CorsOrigins=${RBACR_CORS_ORIGINS:-}"
  "TrustedIssuers=${RBACR_TRUSTED_ISSUERS:-}")
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
for pair in StripeWebhookSecret:RBACR_STRIPE_WEBHOOK_SECRET StripeApiKey:RBACR_STRIPE_API_KEY; do
  param="${pair%%:*}" name="${pair#*:}"
  if [[ -n "${!name:-}" ]]; then params+=("$param=${!name}"); fi
done
params+=("HealthNotificationEmails=${HEALTH_EMAILS:-julio+health@nu01.com}")
# The header value CloudFront sends and the app requires: a plain SSM String
# (standard tier, free; see infra/app.yaml). A stage's first deploy creates
# it; afterwards it must exist, because a new value would reach the Lambda
# and CloudFront minutes apart and requests in between would get 403. Its
# value is never printed.
ORIGIN_SECRET_PARAM="/rbacr/$STAGE/origin-secret"
params+=("OriginSecretParameter=$ORIGIN_SECRET_PARAM")
if ! aws ssm get-parameter --name "$ORIGIN_SECRET_PARAM" --query Parameter.Version --output text >/dev/null 2>&1; then
  if $first_deploy; then
    echo "    creating the SSM parameter $ORIGIN_SECRET_PARAM"
    aws ssm put-parameter --name "$ORIGIN_SECRET_PARAM" --type String --tier Standard \
      --description "Header value CloudFront sends to the $STACK Lambda (infra/app.yaml)" \
      --value "$(openssl rand -hex 24)" \
      --tags Key=project,Value=rbacr "Key=tenancy,Value=$TENANCY" >/dev/null
  else
    echo "error: the SSM parameter $ORIGIN_SECRET_PARAM is missing; an administrator creates it with the stack's current origin secret (infra/README.md)" >&2
    exit 1
  fi
fi
# Unset keeps the deployed value (default 365 days).
if [[ -n "${RBACR_SESSION_RETENTION_DAYS:-}" ]]; then
  if [[ ! "$RBACR_SESSION_RETENTION_DAYS" =~ ^[1-9][0-9]{0,4}$ ]]; then
    echo "error: RBACR_SESSION_RETENTION_DAYS must be a whole number of days, 1 or more" >&2
    exit 1
  fi
  params+=("SessionRetentionDays=$RBACR_SESSION_RETENTION_DAYS")
fi
# Addresses are people's: logged only as a count.
roots=0; [[ -n "${RBACR_ROOT_LIST:-}" ]] && roots=$(tr ',' '\n' <<<"$RBACR_ROOT_LIST" | grep -c .)
echo "    root allow list: $roots entr(ies)"
echo "    Google ID token audiences: ${RBACR_GOOGLE_AUDIENCES:-none}"
echo "    trusted ID token issuers: ${RBACR_TRUSTED_ISSUERS:-none}"
echo "    CORS origins: ${RBACR_CORS_ORIGINS:-none}"

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
  --template-file infra/artifacts.yaml --tags "${TAGS[@]}" --no-fail-on-empty-changeset
bucket="$(stack_output "$ARTIFACTS_STACK" ArtifactsBucketName)"
key="lambda/rbacr-$RELEASE-$(git rev-parse --short HEAD 2>/dev/null || echo local)-$BUILD_NUMBER.zip"
aws s3 cp "$zip" "s3://$bucket/$key" --only-show-errors
echo "    code: s3://$bucket/$key"

echo "==> deploying $TABLES_STACK"
aws cloudformation deploy --stack-name "$TABLES_STACK" \
  --template-file infra/tables.yaml --parameter-overrides "TableName=$STACK" \
  --tags "${TAGS[@]}" --no-fail-on-empty-changeset
table_arn="$(stack_output "$TABLES_STACK" TableArn)"
sessions_table_arn="$(stack_output "$TABLES_STACK" SessionsTableArn)"
echo "    table: $table_arn"
echo "    sessions table: $sessions_table_arn"

# 3. The app
echo "==> deploying $STACK"
aws cloudformation deploy --stack-name "$STACK" \
  --template-file infra/app.yaml --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND \
  --parameter-overrides "${params[@]}" "CodeBucket=$bucket" "CodeKey=$key" \
    "TableName=$STACK" "TableArn=$table_arn" \
    "SessionsTableName=$STACK-sessions" "SessionsTableArn=$sessions_table_arn" \
  --tags "${TAGS[@]}" --no-fail-on-empty-changeset
function_url="$(stack_output "$STACK" FunctionUrl)"

# 4. Smoke test (retried: on a first deploy DNS and the edge take a moment)
echo "==> checking https://$DOMAIN/"
status() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }
check() {
  local health
  health="$(curl -fsS --max-time 20 "https://$DOMAIN/health")" || { echo "    /health failed"; return 1; }
  [[ "$health" == "{\"ok\":true,\"version\":\"$RELEASE\",\"checks\":{\"google\":\"ok\"}}" ]] \
    || { echo "    /health says $health, want healthy and version $RELEASE"; return 1; }
  curl -fsS --max-time 20 -H 'accept: text/html' "https://$DOMAIN/" | grep -q 'Sign in with Google' \
    || { echo "    / isn't the sign-in page"; return 1; }
  local code
  code="$(status "https://$DOMAIN/api/me")"; [[ "$code" == 401 ]] || { echo "    /api/me answered $code, want 401"; return 1; }
  # An unknown token is looked up in DynamoDB: 401 (not 500) proves the table works.
  code="$(status -H 'authorization: Bearer rbacr_smoke-test-unknown-token' "https://$DOMAIN/api/me")"
  [[ "$code" == 401 ]] || { echo "    /api/me with an unknown token answered $code, want 401"; return 1; }
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
