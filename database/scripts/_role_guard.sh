#!/usr/bin/env bash

require_oneview_vm_role() {
  local expected_role="$1"
  local env_file="${2:-${ONEVIEW_ENV_FILE:-/etc/oneview/oneview.env}}"

  if [[ "${ONEVIEW_VM_ROLE:-}" != "${expected_role}" ]]; then
    echo "This script is ${expected_role} VM only." >&2
    echo "Set ONEVIEW_VM_ROLE=${expected_role} in ${env_file} before running it." >&2
    exit 1
  fi
}
