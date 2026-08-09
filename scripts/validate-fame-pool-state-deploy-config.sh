#!/usr/bin/env bash
set -euo pipefail

missing=()
for name in FAME_POOL_STATE_INDEXER_BASE_RPCS_JSON FAME_POOL_STATE_SERVICE_TOKEN; do
  if [ -z "${!name:-}" ]; then
    missing+=("$name")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  printf 'Missing required FAME pool-state deployment configuration: %s\n' "${missing[*]}"
  exit 1
fi

base_rpcs_validation="$(
  node -e '
const name = "FAME_POOL_STATE_INDEXER_BASE_RPCS_JSON";
const raw = process.env[name];
let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  console.error(`${name} must be valid JSON.`);
  process.exit(1);
}
if (
  !Array.isArray(parsed) ||
  parsed.length === 0 ||
  parsed.some((rpc) => typeof rpc !== "string" || rpc.trim().length === 0)
) {
  console.error(`${name} must be a non-empty JSON array of non-empty RPC URLs.`);
  process.exit(1);
}
' 2>&1
)" || {
  printf '%s\n' "$base_rpcs_validation"
  exit 1
}
