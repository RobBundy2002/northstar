#!/bin/sh
set -eu

if [ -n "${NORTHSTAR_KUBECONFIG_SERVER_HOST:-}" ] && [ -f "${NORTHSTAR_KUBECONFIG:-/kube/config}" ]; then
  patched=/tmp/northstar-kubeconfig
  cp "${NORTHSTAR_KUBECONFIG:-/kube/config}" "$patched"
  sed -i "s#server: https://127.0.0.1:#server: https://${NORTHSTAR_KUBECONFIG_SERVER_HOST}:#g" "$patched"
  sed -i "s#server: https://localhost:#server: https://${NORTHSTAR_KUBECONFIG_SERVER_HOST}:#g" "$patched"
  export KUBECONFIG="$patched"
  export NORTHSTAR_KUBECONFIG="$patched"
fi

exec "$@"
