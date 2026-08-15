#!/bin/sh
set -eu

# Docker containers cannot reach host-published Kubernetes API servers through
# 127.0.0.1. For local kind clusters, copy the read-only kubeconfig and
# rewrite only loopback API endpoints to the Docker host gateway.
if [ -n "${NORTHSTAR_KUBECONFIG_SERVER_HOST:-}" ]; then
  source_config="${NORTHSTAR_KUBECONFIG_SOURCE:-/kube/config}"
  rewritten_config="${NORTHSTAR_KUBECONFIG_REWRITTEN:-/tmp/northstar-kubeconfig}"
  awk -v host="$NORTHSTAR_KUBECONFIG_SERVER_HOST" '
    /^    server: https:\/\/(127\.0\.0\.1|localhost):[0-9]+$/ {
      endpoint=$0
      sub(/^    server: https:\/\//, "", endpoint)
      split(endpoint, parts, ":")
      print "    server: https://" host ":" parts[2]
      print "    tls-server-name: " parts[1]
      next
    }
    { print }
  ' "$source_config" > "$rewritten_config"
  export NORTHSTAR_KUBECONFIG="$rewritten_config"
fi

exec "$@"
