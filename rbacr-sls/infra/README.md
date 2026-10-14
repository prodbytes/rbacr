# infra

rbacr's AWS infrastructure, as CloudFormation templates. Everything lives in
**us-east-1**, because CloudFront certificates must be there.

| Template | Stack | Holds | Deployed by |
|---|---|---|---|
| [zone.yaml](zone.yaml) | `rbacr-zone` | The public hosted zone `rbacr.nu01.com`, its NS delegation in the `nu01.com` zone, a CAA record (only Amazon issues certificates), and `local.rbacr.nu01.com → 127.0.0.1` for local HTTPS | An administrator, once |
| [github-deploy.yaml](github-deploy.yaml) | `rbacr-github-deploy` | The `rbacr-github-deploy` role (`*GA` tags), the `rbacr-github-deploy-rc` role (`*RC*` tags and manual runs from `main`), and the `rbacr-lambda-boundary` permissions boundary | An administrator, once |
| [artifacts.yaml](artifacts.yaml) | `rbacr-artifacts`, `rbacr-rc-artifacts` | A private bucket for the Lambda zips; old zips expire after 90 days | [scripts/deploy.sh](../scripts/deploy.sh) |
| [tables.yaml](tables.yaml) | `rbacr-tables`, `rbacr-rc-tables` | The DynamoDB tables (`rbacr` and `rbacr-sessions`, `rbacr-rc` and `rbacr-rc-sessions`): on demand, point-in-time recovery, deletion protection, kept if the stack is deleted | [scripts/deploy.sh](../scripts/deploy.sh) |
| [app.yaml](app.yaml) | `rbacr`, `rbacr-rc` | The ACM certificate, the Lambda with its function URL and log group, the CloudFront distribution with its WAF web ACL, the A/AAAA aliases, and the function alarms with their e-mail topic. The origin secret is an SSM parameter (`/rbacr/<stage>/origin-secret`), outside the stack | [scripts/deploy.sh](../scripts/deploy.sh) |

## How a request flows

```
browser ──https──▶ CloudFront (rbacr.nu01.com, ACM certificate)
                     │ WAF: rate limits per IP (429), AWS known-bad-inputs rules
                     │ adds x-rbacr-origin-secret (from SSM Parameter Store)
                     │ and x-rbacr-host: rbacr.nu01.com
                     ▼
                   Lambda function URL ──▶ lambda.js ──▶ SvelteKit (adapter-node)
                                                           │
                                                           ▼
                                                     DynamoDB table rbacr / rbacr-rc
```

- **Caching.** `/_app/immutable/*` holds content-hashed assets and is cached
  at the edge. Everything else is not cached, and every viewer header except
  `Host`, plus all cookies and query strings, is forwarded. AWS's managed
  security-headers policy is added to every response.
- **Locking down the function URL.** The URL is public (`AuthType: NONE`),
  but the app refuses any request without the `x-rbacr-origin-secret` header
  (`RBACR_ORIGIN_SECRET`), and only CloudFront sends it. The value lives in
  the SSM String parameter `/rbacr/<stage>/origin-secret` (`prod` or `rc`;
  standard tier, so free), which scripts/deploy.sh creates on a stage's first
  deploy and CloudFormation resolves into both the Lambda's environment and
  the CloudFront origin header on every deploy. It isn't a SecureString:
  CloudFormation can't resolve those into either place, and the value is
  readable in the function's and the distribution's configuration anyway.
  To change it, expect 403s for the few minutes between the Lambda's update
  and CloudFront's. CloudFront's IAM origin access control for Lambda is not
  used: it requires the viewer to sign POST bodies, which HTML forms can't
  do.
- **Host header.** Because `Host` isn't forwarded, the Lambda sees the
  function URL's host. CloudFront therefore sends the site's host in
  `x-rbacr-host`, and adapter-node reads it (`HOST_HEADER`). That keeps
  SvelteKit's CSRF origin check and the Google redirect URI correct.
- **Secrets.** `RBACR_GOOGLE_CLIENT_SECRET` is a `NoEcho` stack parameter,
  stored as a Lambda environment variable (encrypted at rest). The function
  reaches DynamoDB with its execution role, so there are no database
  credentials.
- **Monitoring.** `https://<domain>/health` is polled every 5 minutes by
  the central `nu01-monitor` stack (the nu01 repository), which e-mails
  `julio+health@nu01.com`; this stack no longer has a Route 53 health check.
  `/health` answers 503 unless the Google client is configured; it doesn't
  touch DynamoDB, so polls cost nothing there. Because it doesn't reach the
  database, `<stack>-errors` (5 or more function errors in 5 minutes) and
  `<stack>-throttles` (any throttled invocation, the account's Lambda
  concurrency running out) notify the `<stack>-health` SNS topic, again on
  recovery. The topic e-mails the
  `HealthNotificationEmails` parameter (comma-separated, default
  `julio+health@nu01.com`; `HEALTH_EMAILS` for scripts/deploy.sh, which
  always passes it: `Fn::ForEach` doesn't resolve parameter defaults). Each
  address must click the confirmation link SNS sends it after the first
  deploy. The template uses the `AWS::LanguageExtensions` transform
  (`Fn::ForEach` over the addresses), so deploys pass
  `CAPABILITY_AUTO_EXPAND`.
- **Database.** Each stage has two DynamoDB tables (`infra/tables.yaml`,
  stack `<stack>-tables`), deployed before the app, which gets their names
  and ARNs: the main table, which never deletes anything (SPEC L1), and
  `<stack>-sessions` for sign-in sessions. On-demand billing, so an idle stage costs only storage (the first
  25 GB are free). Point-in-time recovery, deletion protection and
  `DeletionPolicy: Retain` keep the data safe from a mistaken stack
  deletion. The function's role may only read and write those tables and
  the main one's index. DynamoDB's TTL (`ttl` attribute) purges a session
  `SessionRetentionDays` after it expires (default 365;
  `RBACR_SESSION_RETENTION_DAYS` for scripts/deploy.sh; unset keeps the
  deployed value). The sessions tables are named in `rbacr-lambda-boundary`
  and the deploy roles ([github-deploy.yaml](github-deploy.yaml)), so
  redeploy that stack by hand before the first deploy that creates them.

## Releases

Version numbers are X.Y.Z. X and Y come from
[version.X.txt](../version.X.txt) and [version.Y.txt](../version.Y.txt); Z
is the UTC time of tagging (`YYYYMMDDHHMM`, see
[scripts/version.sh](../scripts/version.sh)).

| Command | Tag | Workflows |
|---|---|---|
| `bash scripts/release-rc.sh` | `X.Y.Z-RC` (any commit that is pushed) | [Release](../../.github/workflows/release.yml) publishes a prerelease with the Lambda zip. [Deploy RC](../../.github/workflows/deploy-rc.yml) deploys https://rc.rbacr.nu01.com |
| `bash scripts/release-ga.sh` | `X.Y.Z-GA` (commits on `main` only) | Release publishes the latest release. [Deploy](../../.github/workflows/deploy.yml) deploys https://rbacr.nu01.com |

`DRY_RUN=1` prints the tag without pushing it. Both scripts refuse
uncommitted or unpushed work, and tags that already exist. Pull requests that
touch the app run the Release workflow's build and tests, without publishing.

`scripts/deploy.sh` runs these steps:

1. Builds the app and packages the zip
   ([scripts/package-lambda.sh](../scripts/package-lambda.sh): production
   dependencies only, smoke-tested through `lambda.js`).
2. Deploys `artifacts.yaml` and uploads the zip.
3. Deploys `app.yaml`.
4. Checks the live site: `/health` must be healthy and report the tag; `/` must be the
   sign-in page; anonymous `/api/me` must return 401; `/login/dev` must
   return 404; and the bare function URL must return 403.

You can also run it by hand with admin credentials (inside devbox):
`STAGE=rc TAG=0.1.<Z>-RC bash scripts/deploy.sh`. Settings not already in
the environment are read from the git-ignored `.env.$STAGE` (`.env.prod`,
`.env.rc`): `KEY=value` lines for `RBACR_*`, `HEALTH_EMAILS` and
`HOSTED_ZONE_ID`. The file is parsed, not sourced.

Every stack carries the cost-allocation tags `project=rbacr` and `tenancy`
(`GA` for prod, `RC` for rc, `shared` for `rbacr-zone` and
`rbacr-github-deploy`), which CloudFormation copies to its resources; the
hosted zone, which doesn't get stack tags, sets them explicitly, and
scripts/deploy.sh tags the origin secret parameter it creates.

## One-time setup

1. **The zone.** Deploy it with administrator credentials. `Z04838091YTBIM6PNI1XK`
   is the `nu01.com` zone (`aws route53 list-hosted-zones-by-name --dns-name nu01.com`).

   ```bash
   aws cloudformation deploy --region us-east-1 --stack-name rbacr-zone \
     --template-file infra/zone.yaml \
     --parameter-overrides ParentHostedZoneId=Z04838091YTBIM6PNI1XK \
     --tags project=rbacr tenancy=shared
   aws cloudformation describe-stacks --region us-east-1 --stack-name rbacr-zone \
     --query 'Stacks[0].Outputs'   # HostedZoneId
   ```

2. **The deploy roles.** They create IAM resources, so an administrator
   deploys them. The account already has GitHub's OIDC provider (from
   prodbytes/presence); pass `CreateOidcProvider=true` only in an account
   that doesn't.

   ```bash
   aws cloudformation deploy --region us-east-1 --stack-name rbacr-github-deploy \
     --template-file infra/github-deploy.yaml --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides HostedZoneId=<rbacr-zone HostedZoneId> \
       DistributionId=<rbacr DistributionId> RcDistributionId=<rbacr-rc DistributionId> \
     --tags project=rbacr tenancy=shared
   ```

   `DistributionId` and `RcDistributionId` are the app stacks' `DistributionId`
   outputs (empty before a stage's first deploy; the template's defaults are
   the current ones). Update them if a distribution is ever replaced.

   The roles trust only this repository's tokens, in both subject forms
   (`repo:prodbytes@288014477/rbacr@1404734829:…` and `repo:prodbytes/rbacr:…`).
   Each one may manage only its own stage's stacks, function, log group,
   origin secret parameter, bucket and DNS names. The roles can create the Lambda's execution
   role only with the `rbacr-lambda-boundary` boundary attached, so a deploy
   can never create a role that does more than write logs. Each role may
   create a CloudFront distribution but read, change or delete only its own
   stage's (by id): another stage's configuration holds that stage's origin
   secret, so nothing lists or reads distributions in general. Each manages
   only its own WAF web ACL (`rbacr-waf`, `rbacr-rc-waf`) and alarms, by
   name. Neither may read, write, export, restore or delete the tables'
   data, nor delete a table: an explicit deny, so a compromised deploy run
   can't reach the data. ACM permissions remain account-wide, because
   certificate ids aren't known in advance (so do the leftover Route 53
   health check delete permissions, until the next deploy of each stage
   has removed the old health checks).
   Redeploy this stack whenever `github-deploy.yaml` changes, **before**
   the release that needs it (for example, the WAF permissions before the
   first release with the web ACL): the deploy roles can't update
   themselves.

3. **Repository settings.** Variables are public identifiers; secrets are
   not. Each tenant has its own settings, named `RBACR_<TENANT>_<NAME>`:
   `GA` (production, read by [deploy.yml](../../.github/workflows/deploy.yml)),
   `RC` (release candidate, read by
   [deploy-rc.yml](../../.github/workflows/deploy-rc.yml)) and `LOCAL`
   (Codespaces secrets, written to `.env` by
   [scripts/local-env.sh](../scripts/local-env.sh) when a codespace is
   created). The workflows pass `RBACR_<TENANT>_<NAME>` to the app as
   `RBACR_<NAME>`.

   ```bash
   gh variable set AWS_DEPLOY_ROLE_ARN --body "<DeployRoleArn>"
   gh variable set AWS_DEPLOY_RC_ROLE_ARN --body "<RcDeployRoleArn>"
   gh variable set HOSTED_ZONE_ID --body "<rbacr-zone HostedZoneId>"
   for t in GA RC; do
     gh variable set "RBACR_${t}_ROOT_LIST" --body "nu01.com"
     gh variable set "RBACR_${t}_GOOGLE_CLIENT_ID" --body "<client id>.apps.googleusercontent.com"
     gh variable set "RBACR_${t}_HEALTH_EMAILS" --body "julio+health@nu01.com"  # optional
     # optional: apps whose users call /api with Google ID tokens (README "Apps calling rbacr as their users")
     gh variable set "RBACR_${t}_GOOGLE_AUDIENCES" --body "<app web client id>,<app android client id>"
     # optional: OIDC issuers besides Google (README "Apps with their own ID tokens"), a JSON array
     gh variable set "RBACR_${t}_TRUSTED_ISSUERS" --body '[{"issuer":"https://app.example.com/auth","jwks":"https://app.example.com/auth/jwks.json","audiences":["app"]}]'
     gh variable set "RBACR_${t}_CORS_ORIGINS" --body "https://app.example.com"
     gh secret set "RBACR_${t}_GOOGLE_CLIENT_SECRET"
   done
   # LOCAL, for codespaces (optional; local machines use .env directly)
   gh secret set --app codespaces RBACR_LOCAL_ROOT_LIST --body "nu01.com"
   gh secret set --app codespaces RBACR_LOCAL_GOOGLE_CLIENT_ID
   gh secret set --app codespaces RBACR_LOCAL_GOOGLE_CLIENT_SECRET
   gh secret set --app codespaces RBACR_LOCAL_DEV_LOGIN --body 1
   ```

4. **Google.** On the OAuth web client, add these authorised redirect URIs:
   - `https://rbacr.nu01.com/login/google/callback`
   - `https://rc.rbacr.nu01.com/login/google/callback`
   - `https://local.rbacr.nu01.com:8444/login/google/callback`, for local
     HTTPS through [Floci](../floci/README.md)

5. **Tag protection.** A pushed `*GA` or `*RC*` tag deploys with that
   stage's role, running the workflow file of the tagged commit. So only
   administrators may create, move or delete those tags (the release
   scripts run as an administrator):

   ```bash
   gh api -X POST repos/prodbytes/rbacr/rulesets --input - <<'JSON'
   {
     "name": "release tags",
     "target": "tag",
     "enforcement": "active",
     "conditions": { "ref_name": { "include": ["refs/tags/*GA", "refs/tags/*RC*"], "exclude": [] } },
     "rules": [{ "type": "creation" }, { "type": "update" }, { "type": "deletion" }],
     "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }]
   }
   JSON
   ```

   (`actor_id` 5 is the repository's admin role.)

Then run `bash scripts/release-rc.sh`. The first deploy of each stage waits
for its certificate to validate, which usually takes a few minutes.

## Moving from Secrets Manager and the Route 53 health check (one-time)

Stacks deployed before October 2026 kept the origin secret in Secrets
Manager (`rbacr-origin-secret`, `rbacr-rc-origin-secret`, about $0.40 a
month each) and had a Route 53 health check. The first deploy without them
needs, in this order:

1. An administrator copies each stage's current secret into its SSM
   parameter, so the Lambda and CloudFront keep the same value through the
   deploy (no request is refused), without printing it:

   ```bash
   for s in prod:rbacr:GA rc:rbacr-rc:RC; do
     IFS=: read -r stage stack tenancy <<<"$s"
     aws ssm put-parameter --region us-east-1 --name "/rbacr/$stage/origin-secret" \
       --type String --tier Standard \
       --description "Header value CloudFront sends to the $stack Lambda (infra/app.yaml)" \
       --tags Key=project,Value=rbacr "Key=tenancy,Value=$tenancy" \
       --value "$(aws secretsmanager get-secret-value --region us-east-1 \
         --secret-id "$stack-origin-secret" --query SecretString --output text)" >/dev/null
   done
   ```

   scripts/deploy.sh refuses to deploy an existing stage whose parameter is
   missing.
2. An administrator redeploys `rbacr-github-deploy` (step 2 above): the
   roles need the SSM permissions.
3. Release RC, then GA. Each stage's deploy deletes its health check, the
   `<stack>-health` alarm, and its Secrets Manager secret. Then the
   secret and health check permissions marked as such in
   `github-deploy.yaml` can be removed (and `rbacr-github-deploy`
   redeployed).

## Validating changes

```bash
cfn-lint infra/*.yaml        # pip install cfn-lint
for f in infra/*.yaml; do aws cloudformation validate-template --template-body "file://$f" >/dev/null; done
```
