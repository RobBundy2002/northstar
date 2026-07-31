# Northstar

Northstar is a browser-based Kubernetes operations cockpit for contexts, namespaces, pods, workloads, nodes, events, logs, actions, Metrics Server, and Prometheus.

## Connect to an existing cluster

Requirements: Node.js 18+, `kubectl`, and a kubeconfig that can already access the cluster.

```bash
cp .env.example .env
export NORTHSTAR_MODE=kubernetes
export NORTHSTAR_KUBECTL=kubectl
export NORTHSTAR_KUBECONFIG="$HOME/.kube/config"
export NORTHSTAR_CONTEXT=my-context
npm start
```

Open `http://localhost:5173`. Northstar discovers every context in the kubeconfig and lets the operator switch between them. Actions require RBAC permissions for the selected resources.

For Prometheus-backed queries, also set:

```bash
export NORTHSTAR_PROMETHEUS_URL=http://prometheus.monitoring.svc:9090
npm start
```

## Docker Compose

Build and run Northstar with a kubeconfig mounted read-only:

```bash
export NORTHSTAR_KUBECONFIG_PATH="$HOME/.kube/config"
docker compose up --build
```

The Compose setup starts Northstar and Prometheus. It is intended for a local or private network; do not expose the operator endpoint publicly without authentication and a restricted RBAC profile.

## Helm

Build and publish the image to a registry visible to the target cluster, then create a kubeconfig secret:

```bash
docker build -t registry.example.com/northstar:latest .
docker push registry.example.com/northstar:latest
kubectl create secret generic northstar-kubeconfig \
  --from-file=config="$HOME/.kube/config" \
  -n northstar --dry-run=client -o yaml | kubectl apply -f -
helm upgrade --install northstar ./helm/northstar \
  --namespace northstar --create-namespace \
  --set image.repository=registry.example.com/northstar \
  --set image.tag=latest \
  --set context=my-context
```

The chart creates a ServiceAccount, ClusterRole, ClusterRoleBinding, Deployment, and Service. Review the RBAC rules before using it in production; the default role permits operational mutations such as restart, scale, resource updates, and delete.

## Local demo

The local Docker-backed demo remains available:

```bash
npm run start:all
```

If port 5173 or 9090 is already occupied, Northstar automatically selects the next available port and updates its Prometheus scrape target.
