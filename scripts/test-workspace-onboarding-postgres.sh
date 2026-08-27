#!/usr/bin/env bash
set -euo pipefail

configured_url="${WORKSPACE_ONBOARDING_DATABASE_URL_UNPOOLED:-${DATABASE_URL_UNPOOLED:-${DATABASE_URL:-}}}"
temporary_database=""

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$temporary_database" ]]; then
    if command -v runuser >/dev/null 2>&1 && runuser -u postgres -- true >/dev/null 2>&1; then
      runuser -u postgres -- dropdb --if-exists "$temporary_database" >/dev/null
    else
      dropdb --if-exists "$temporary_database" >/dev/null
    fi
    if psql -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname = '${temporary_database}'" | grep -q 1; then
      printf '%s\n' "Workspace onboarding integration cleanup failed." >&2
      exit 1
    fi
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

if [[ -z "$configured_url" && -f .env.workspace-onboarding.local ]]; then
  line=$(<.env.workspace-onboarding.local)
  case "$line" in
    WORKSPACE_ONBOARDING_DATABASE_URL_UNPOOLED=*) configured_url="${line#*=}" ;;
    *) printf '%s\n' "Unexpected .env.workspace-onboarding.local format." >&2; exit 2 ;;
  esac
fi

if [[ -z "$configured_url" ]]; then
  for command in psql createdb dropdb; do
    if ! command -v "$command" >/dev/null 2>&1; then
      printf '%s\n' "Real PostgreSQL is required. Install PostgreSQL or set WORKSPACE_ONBOARDING_DATABASE_URL_UNPOOLED." >&2
      exit 2
    fi
  done
  if ! psql -d postgres -Atqc "SELECT 1" >/dev/null 2>&1; then
    printf '%s\n' "Local PostgreSQL is unavailable. Start it or set WORKSPACE_ONBOARDING_DATABASE_URL_UNPOOLED." >&2
    exit 2
  fi
  temporary_database="fuse_onboarding_test_$(date +%s)_${RANDOM}"
  if ! createdb "$temporary_database" >/dev/null 2>&1; then
    if ! command -v runuser >/dev/null 2>&1 \
      || ! runuser -u postgres -- createdb --owner="$(id -un)" "$temporary_database" >/dev/null 2>&1; then
      printf '%s\n' "Unable to create an isolated PostgreSQL test database." >&2
      exit 2
    fi
  fi
  configured_url="postgresql:///${temporary_database}?host=/var/run/postgresql"
fi

RUN_WORKSPACE_ONBOARDING_POSTGRES_INTEGRATION=1 \
WORKSPACE_ONBOARDING_DATABASE_URL_UNPOOLED="$configured_url" \
npx vitest run tests/workspaceOnboardingRecovery.postgres.test.ts
