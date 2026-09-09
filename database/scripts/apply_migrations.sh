#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ONEVIEW_ENV_FILE:-/etc/oneview/oneview-db.env}"
if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${ENV_FILE}"
  set +a
fi

# shellcheck source=scripts/_role_guard.sh
source "${SCRIPT_DIR}/_role_guard.sh"
require_oneview_vm_role db "${ENV_FILE}"

REPO_ROOT="${ONEVIEW_REPO_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
PYTHON_BIN="${ONEVIEW_PYTHON_BIN:-${REPO_ROOT}/.venv/bin/python}"
if [[ ! -x "${PYTHON_BIN}" ]]; then
  PYTHON_BIN="${ONEVIEW_PYTHON_BIN:-python3}"
fi

if [[ -z "${MIGRATION_DATABASE_URL:-}" ]]; then
  echo "MIGRATION_DATABASE_URL is required for migrations." >&2
  exit 1
fi
if [[ "${CONFIRM_APPLY_MIGRATIONS:-false}" != "true" ]]; then
  echo "Refusing to apply migrations without CONFIRM_APPLY_MIGRATIONS=true." >&2
  echo "Run read-only diagnostics, backup and role validation before enabling this flag." >&2
  exit 1
fi
"${PYTHON_BIN}" - <<'PY'
import os
import sys
from urllib.parse import urlparse

expected_user = os.getenv("POSTGRES_OWNER_USER", "oneview_owner")
parsed = urlparse(os.getenv("MIGRATION_DATABASE_URL", ""))
if parsed.username != expected_user:
  print(f"MIGRATION_DATABASE_URL must use {expected_user}, found {parsed.username or '-'}", file=sys.stderr)
  sys.exit(1)
PY

cd "${REPO_ROOT}"
"${PYTHON_BIN}" -m alembic -c alembic.ini upgrade head
"${PYTHON_BIN}" -m alembic -c alembic.ini current
