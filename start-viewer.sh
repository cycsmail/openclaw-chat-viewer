#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_OPENCLAW_HOME="${HOME}/.openclaw"

log() {
  printf '%s\n' "$*" >&2
}

is_valid_openclaw_home() {
  [[ -d "$1" ]] && [[ -d "$1/agents" ]]
}

pick_openclaw_home() {
  if [[ -n "${OPENCLAW_HOME:-}" ]]; then
    if is_valid_openclaw_home "${OPENCLAW_HOME}"; then
      log "Using OPENCLAW_HOME=${OPENCLAW_HOME}"
      printf '%s\n' "${OPENCLAW_HOME}"
      return 0
    fi
    log "OPENCLAW_HOME is set but is not a valid OpenClaw directory: ${OPENCLAW_HOME}"
  fi

  if is_valid_openclaw_home "${DEFAULT_OPENCLAW_HOME}"; then
    log "Found OpenClaw dir at ${DEFAULT_OPENCLAW_HOME}"
    printf '%s\n' "${DEFAULT_OPENCLAW_HOME}"
    return 0
  fi

  while true; do
    read -r -p "OpenClaw dir not found at ${DEFAULT_OPENCLAW_HOME}. Enter your OpenClaw directory: " input_dir
    input_dir="${input_dir/#\~/${HOME}}"
    if is_valid_openclaw_home "${input_dir}"; then
      log "Using OpenClaw dir ${input_dir}"
      printf '%s\n' "${input_dir}"
      return 0
    fi
    log "Directory does not look like an OpenClaw home: ${input_dir}"
  done
}

OPENCLAW_HOME="$(pick_openclaw_home)"
export OPENCLAW_HOME

export ALLOW_REMOTE_BIND="${ALLOW_REMOTE_BIND:-1}"
export OPENCLAW_ADMIN_PASSWORD="${OPENCLAW_ADMIN_PASSWORD:-changeme}"

cd "${SCRIPT_DIR}"
exec node server.mjs "$@"
