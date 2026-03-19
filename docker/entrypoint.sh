#!/usr/bin/env bash
set -euo pipefail

device="${CLOUDFLARE_DOCS_MCP_MODEL_DEVICE:-cuda}"
data_dir="${CLOUDFLARE_DOCS_MCP_DATA_DIR:-/app/data}"
db_path="${data_dir}/cloudflare-docs.sqlite"
command="${1:-serve}"

mkdir -p "${data_dir}"

case "${command}" in
  serve)
    if [ ! -f "${db_path}" ]; then
      echo "No local index found at ${db_path}. Running setup first."
      npm run setup -- --device "${device}"
    fi

    exec npm run serve -- --device "${device}"
    ;;
  setup|sync)
    exec npm run "${command}" -- --device "${device}"
    ;;
  status|devices|clients|test)
    exec npm run "${command}"
    ;;
  *)
    exec "$@"
    ;;
esac
