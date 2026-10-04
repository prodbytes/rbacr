#!/usr/bin/env bash
# Continuous health monitor: one line per check, one emoji per service.
# Runs via `devbox services up` (see process-compose.yaml) or standalone.
# Check interval in seconds is configurable via HEALTH_CHECK_INTERVAL.
set -uo pipefail

INTERVAL="${HEALTH_CHECK_INTERVAL:-15}"

check_database() {
    if pg_isready -q -h "${PGHOST:-localhost}" -p "${PGPORT:-5432}" \
            -U "${POSTGRES_USER:-postgres}" 2>/dev/null; then
        echo "🐘 database ✅"
    else
        echo "🐘 database ❌"
    fi
}

check_app() {
    if curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:${RBACR_APP_PORT:-5173}/api/health"; then
        echo "🔐 app ✅"
    else
        echo "🔐 app ❌"
    fi
}

# The app through Floci's CloudFront over HTTPS, validating the mkcert
# certificate against mkcert's CA (scripts/local-certs.sh). --resolve keeps it
# working before local.rbacr.nu01.com's DNS record exists.
check_https() {
    local host="${RBACR_PUBLIC_HOST:-local.rbacr.nu01.com}" port="${RBACR_FLOCI_HTTPS_PORT:-8444}"
    local ca
    ca="$(mkcert -CAROOT 2>/dev/null)/rootCA.pem"
    if curl -fsS -o /dev/null --max-time 5 --cacert "$ca" \
            --resolve "$host:$port:127.0.0.1" "https://$host:$port/api/health"; then
        echo "🔒 https ✅"
    else
        echo "🔒 https ❌"
    fi
}

while true; do
    # Add more services here, one check_* call per service, joined on one line
    printf '%s %s %s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$(check_database)" "$(check_app)" "$(check_https)"
    sleep "$INTERVAL"
done
