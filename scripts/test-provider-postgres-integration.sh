#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${NEON_INTEGRATION_DATABASE_URL_UNPOOLED:-}" && -z "${DATABASE_URL_UNPOOLED:-}" && -z "${DATABASE_URL:-}" && -f .env.integration.local ]]; then
  line=$(<.env.integration.local)
  case "$line" in
    NEON_INTEGRATION_DATABASE_URL_UNPOOLED=*) export NEON_INTEGRATION_DATABASE_URL_UNPOOLED="${line#*=}" ;;
    *) printf '%s\n' "Unexpected .env.integration.local format." >&2; exit 2 ;;
  esac
fi

if [[ -z "${NEON_INTEGRATION_DATABASE_URL_UNPOOLED:-}" && -z "${DATABASE_URL_UNPOOLED:-}" && -z "${DATABASE_URL:-}" ]]; then
  if ! psql -d postgres -Atqc "SELECT 1" >/dev/null 2>&1; then
    printf '%s\n' "No database URL is configured and local Postgres is unavailable." >&2
    printf '%s\n' "Set NEON_INTEGRATION_DATABASE_URL_UNPOOLED to an unpooled Neon URL and retry." >&2
    exit 2
  fi
  if ! psql -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname = 'fuse_provider_integration'" | grep -q 1; then
    createdb fuse_provider_integration
  fi
  export NEON_INTEGRATION_DATABASE_URL_UNPOOLED='postgresql:///fuse_provider_integration?host=/var/run/postgresql'
fi

export RUN_NEON_INTEGRATION=1
export FUSE_PROVIDER_CREDENTIAL_ACTIVE_KEY_ID="${FUSE_PROVIDER_CREDENTIAL_ACTIVE_KEY_ID:-v1}"
if [[ -z "${FUSE_PROVIDER_CREDENTIAL_KEY_V1:-}" ]]; then
  export FUSE_PROVIDER_CREDENTIAL_KEY_V1="$(python3 -c 'import base64; print(base64.b64encode(bytes([7]) * 32).decode())')"
fi

exec npx vitest run tests/providerConfigStore.neon.test.ts
