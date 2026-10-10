#!/bin/sh
# Creates the rbacr CloudFront distribution in Floci, mirroring
# infra/app.yaml: every path goes to one origin, here the vite dev server
# (http://$RBACR_ORIGIN_HOST:$RBACR_APP_PORT) instead of the Lambda URL.
#
# Nothing is cached. Every viewer header except Host, plus all cookies and
# query strings, is forwarded (like AWS's managed AllViewerExceptHostHeader
# policy, which Floci doesn't model). The origin host is a *.localhost name:
# compose.yaml maps it to the Docker host in here, and in the browser it's
# loopback, so vite's HMR WebSocket (which Floci can't carry) goes straight
# to the dev server.
set -eu

ORIGIN_HOST="${RBACR_ORIGIN_HOST:-dev.rbacr.localhost}"
ALIAS="${RBACR_CDN_ALIAS:-rbacr.localhost}"
# A public name for 127.0.0.1 (infra/zone.yaml), for Google sign-in, whose
# redirect URIs must be on a public domain.
PUBLIC_HOST="${RBACR_PUBLIC_HOST:-local.rbacr.nu01.com}"
APP_PORT="${RBACR_APP_PORT:-5173}"

cache_policy=$(aws cloudfront create-cache-policy \
  --query CachePolicy.Id --output text \
  --cache-policy-config '{
    "Name": "rbacr-no-cache",
    "MinTTL": 0, "DefaultTTL": 0, "MaxTTL": 0,
    "ParametersInCacheKeyAndForwardedToOrigin": {
      "EnableAcceptEncodingGzip": false,
      "EnableAcceptEncodingBrotli": false,
      "HeadersConfig": {"HeaderBehavior": "none"},
      "CookiesConfig": {"CookieBehavior": "none"},
      "QueryStringsConfig": {"QueryStringBehavior": "none"}
    }
  }')

origin_request_policy=$(aws cloudfront create-origin-request-policy \
  --query OriginRequestPolicy.Id --output text \
  --origin-request-policy-config '{
    "Name": "rbacr-all-viewer-except-host",
    "HeadersConfig": {"HeaderBehavior": "allExcept", "Headers": {"Quantity": 1, "Items": ["Host"]}},
    "CookiesConfig": {"CookieBehavior": "all"},
    "QueryStringsConfig": {"QueryStringBehavior": "all"}
  }')

distribution=$(aws cloudfront create-distribution \
  --query 'Distribution.Id' --output text \
  --distribution-config "{
    \"CallerReference\": \"rbacr-local\",
    \"Comment\": \"rbacr local CDN\",
    \"Enabled\": true,
    \"Aliases\": {\"Quantity\": 2, \"Items\": [\"$ALIAS\", \"$PUBLIC_HOST\"]},
    \"Origins\": {\"Quantity\": 1, \"Items\": [
      {\"Id\": \"app\", \"DomainName\": \"$ORIGIN_HOST\", \"CustomOriginConfig\": {\"HTTPPort\": $APP_PORT, \"HTTPSPort\": 443, \"OriginProtocolPolicy\": \"http-only\"}}
    ]},
    \"DefaultCacheBehavior\": {
      \"TargetOriginId\": \"app\", \"ViewerProtocolPolicy\": \"allow-all\",
      \"CachePolicyId\": \"$cache_policy\", \"OriginRequestPolicyId\": \"$origin_request_policy\",
      \"AllowedMethods\": {\"Quantity\": 7, \"Items\": [\"GET\", \"HEAD\", \"OPTIONS\", \"PUT\", \"POST\", \"PATCH\", \"DELETE\"],
        \"CachedMethods\": {\"Quantity\": 2, \"Items\": [\"GET\", \"HEAD\"]}}
    }
  }")

echo "rbacr: CloudFront distribution $distribution serves https://$PUBLIC_HOST:8444/ and https://$ALIAS:8444/"
