#!/usr/bin/env bash
#
# Local standalone Soroban sandbox for offline dashboard development.
#
# Boots `stellar/quickstart` in local-network mode, waits for its RPC to answer,
# then deploys the pinned guard artifact to it and writes `.env.local`, so the
# console can be developed end to end without depending on public testnet nodes.
#
# Usage:
#   npm run sandbox                      # or: bash scripts/start-local-sandbox.sh
#   bash scripts/start-local-sandbox.sh --down     # stop and remove the container
#   bash scripts/start-local-sandbox.sh --help
#
# Environment overrides:
#   SAG_SANDBOX_CONTAINER     container name            (default: sag-local-sandbox)
#   SAG_SANDBOX_IMAGE         image reference           (default: stellar/quickstart:latest)
#   SAG_SANDBOX_PORT          host port to publish      (default: 8000)
#   SAG_SANDBOX_FLAGS         container flags           (default: --local --enable core,horizon,rpc)
#   SAG_SANDBOX_WAIT_SECONDS  how long to wait for RPC  (default: 180)
#
# The container is ephemeral (no volume), so stopping it throws the local ledger
# away. Re-running the script redeploys the guard at the same address, because the
# deploy salt is fixed — see scripts/deploy-local.ts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

CONTAINER_NAME="${SAG_SANDBOX_CONTAINER:-sag-local-sandbox}"
IMAGE="${SAG_SANDBOX_IMAGE:-stellar/quickstart:latest}"
HOST_PORT="${SAG_SANDBOX_PORT:-8000}"
WAIT_SECONDS="${SAG_SANDBOX_WAIT_SECONDS:-180}"
PASSPHRASE="Standalone Network ; February 2017"

# `--local` is what current quickstart tags take; older tags used `--standalone`.
# Split on whitespace so a multi-flag override works.
read -r -a CONTAINER_FLAGS <<< "${SAG_SANDBOX_FLAGS:---local --enable core,horizon,rpc}"

# The RPC path moved between image generations: newer tags serve it at `/rpc`,
# while the `/soroban/rpc` path (still what most guides, and this project's own
# issue text, use) is what older tags and standalone mode expose. Both are probed
# and whichever answers is the one written to `.env.local`.
RPC_PATH_CANDIDATES=("/soroban/rpc" "/rpc")

RPC_URL=""

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'sandbox: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Start a local standalone Soroban network and deploy the pinned guard artifact to it.

Usage:
  bash scripts/start-local-sandbox.sh [--down|--help]

Options:
  --down, --stop   stop and remove the sandbox container, then exit
  --help, -h       show this message

Environment overrides:
  SAG_SANDBOX_CONTAINER, SAG_SANDBOX_IMAGE, SAG_SANDBOX_PORT,
  SAG_SANDBOX_FLAGS, SAG_SANDBOX_WAIT_SECONDS
EOF
}

require_docker() {
  command -v docker >/dev/null 2>&1 ||
    fail "docker is required: https://docs.docker.com/get-docker/"
  docker info >/dev/null 2>&1 ||
    fail "docker is installed, but the daemon is not reachable. Start Docker and try again."
}

container_running() {
  local state
  state="$(docker inspect -f '{{.State.Running}}' "${CONTAINER_NAME}" 2>/dev/null || printf 'false')"
  [ "${state}" = "true" ]
}

container_exists() {
  docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1
}

# A single JSON-RPC call. curl is used when present, otherwise node — the project
# already requires node, so this never depends on a tool that may be missing.
rpc_call() {
  local url="$1"
  local method="$2"
  local payload="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${method}\"}"

  if command -v curl >/dev/null 2>&1; then
    curl --silent --max-time 5 --header 'Content-Type: application/json' \
      --data "${payload}" "${url}" 2>/dev/null || true
    return 0
  fi

  node -e 'fetch(process.argv[1], { method: "POST", headers: { "content-type": "application/json" }, body: process.argv[2] }).then((response) => response.text()).then((text) => process.stdout.write(text)).catch(() => process.exit(1));' \
    "${url}" "${payload}" 2>/dev/null || true
}

rpc_ready() {
  local url="$1"
  local response
  for method in getHealth getLatestLedger; do
    response="$(rpc_call "${url}" "${method}")"
    if [ -n "${response}" ] && printf '%s' "${response}" | grep -q '"result"'; then
      return 0
    fi
  done
  return 1
}

# Sets RPC_URL to the first candidate path that answers.
detect_rpc_url() {
  local path
  for path in "${RPC_PATH_CANDIDATES[@]}"; do
    if rpc_ready "http://localhost:${HOST_PORT}${path}"; then
      RPC_URL="http://localhost:${HOST_PORT}${path}"
      return 0
    fi
  done
  return 1
}

wait_for_rpc() {
  local deadline=$((SECONDS + WAIT_SECONDS))
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    if detect_rpc_url; then
      return 0
    fi
    if ! container_running; then
      return 1
    fi
    sleep 3
  done
  return 1
}

start_container() {
  if container_running; then
    log "sandbox: reusing the running container ${CONTAINER_NAME}"
    return 0
  fi

  # A stopped container with the same name would make `docker run` fail.
  if container_exists; then
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  fi

  log "sandbox: starting ${IMAGE} as ${CONTAINER_NAME} on port ${HOST_PORT}"
  log "         docker run -d -i --name ${CONTAINER_NAME} -p ${HOST_PORT}:8000 ${IMAGE} ${CONTAINER_FLAGS[*]}"

  if ! docker run -d -i --name "${CONTAINER_NAME}" -p "${HOST_PORT}:8000" \
    "${IMAGE}" "${CONTAINER_FLAGS[@]}" >/dev/null; then
    fail "docker could not start ${IMAGE}. Check 'docker images' and your daemon."
  fi
}

stop_container() {
  if container_exists; then
    log "sandbox: stopping and removing ${CONTAINER_NAME}"
    docker rm -f "${CONTAINER_NAME}" >/dev/null
  else
    log "sandbox: no container named ${CONTAINER_NAME} — nothing to stop"
  fi
}

report_container_failure() {
  if container_running; then
    fail "the network never answered. Investigate with: docker logs ${CONTAINER_NAME}"
  fi
  log "sandbox: the container exited before the network came up. Last lines:"
  docker logs --tail 30 "${CONTAINER_NAME}" 2>&1 | sed 's/^/    /' || true
  fail "the container stopped. If the image is older, try: SAG_SANDBOX_FLAGS='--standalone' bash scripts/start-local-sandbox.sh"
}

main() {
  case "${1:-}" in
  --down | --stop)
    stop_container
    return 0
    ;;
  --help | -h)
    usage
    return 0
    ;;
  "")
    ;;
  *)
    fail "unknown argument: $1 (try --help)"
    ;;
  esac

  require_docker
  command -v node >/dev/null 2>&1 ||
    fail "node is required (this project needs Node 24 or newer): https://nodejs.org/"

  start_container

  log "sandbox: waiting for the RPC to answer (up to ${WAIT_SECONDS}s)"
  if ! wait_for_rpc; then
    report_container_failure
  fi
  log "sandbox: RPC is up at ${RPC_URL}"

  node scripts/deploy-local.ts --rpc "${RPC_URL}" --passphrase "${PASSPHRASE}" ||
    fail "the local deploy failed. The network is still running; re-run this script, or 'bash scripts/start-local-sandbox.sh --down' to start over."

  log ""
  log "Next steps:"
  log "  npm run dev                          # restart it if it was already running"
  log "  open http://localhost:3000"
  log ""
  log "The local network is ephemeral: 'bash scripts/start-local-sandbox.sh --down'"
  log "stops it and discards the ledger. Re-running this script deploys the same"
  log "guard address again."
}

main "$@"
