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

For a first run against a real cluster, keep cluster actions disabled:

```bash
export NORTHSTAR_READ_ONLY=true
```

Read-only mode still shows contexts, namespaces, pods, workloads, nodes, events, logs, Metrics Server values, and Prometheus queries. It blocks rollout restart, scale, resource changes, delete, and pod exec at the API layer.

Enable actions only after using a scoped kubeconfig or ServiceAccount:

```bash
export NORTHSTAR_READ_ONLY=false
```

For Prometheus-backed queries, also set:

```bash
export NORTHSTAR_PROMETHEUS_URL=http://prometheus.monitoring.svc:9090
npm start
```

## Docker Compose

Build and run Northstar with a kubeconfig mounted read-only. Compose binds the UI and bundled Prometheus to localhost by default.

```bash
cp .env.example .env
# edit .env and set NORTHSTAR_CONTEXT plus NORTHSTAR_KUBECONFIG_PATH
docker compose up --build
```

Open `http://localhost:5173`.

The Compose setup starts Northstar and Prometheus. It is intended for localhost or a private network; do not expose the operator endpoint publicly without authentication and a restricted RBAC profile.

If the target cluster already has Prometheus, set `NORTHSTAR_PROMETHEUS_URL` in `.env`. Otherwise the bundled Prometheus scrapes Northstar's `/metrics` endpoint.

## Real Cluster Handoff

The safest handoff flow for another operator is:

```bash
git clone <repo-url>
cd northstar
cp .env.example .env
```

Edit `.env`:

```bash
NORTHSTAR_CONTEXT=my-real-context
NORTHSTAR_KUBECONFIG_PATH=/Users/me/.kube/config
NORTHSTAR_READ_ONLY=true
```

Then run:

```bash
docker compose up --build
```

To validate the kubeconfig before starting Northstar:

```bash
kubectl --context my-real-context get namespaces
kubectl --context my-real-context top nodes
```

`kubectl top` requires Metrics Server in the target cluster. Northstar still works without it, but CPU and memory cards show `N/A`.

## RBAC Profiles

For a cluster-managed ServiceAccount, start with read-only access:

```bash
kubectl create namespace northstar --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f k8s/northstar-readonly-rbac.yaml
```

Operator access is intentionally separate:

```bash
kubectl apply -f k8s/northstar-operator-rbac.yaml
```

Only use operator access with `NORTHSTAR_READ_ONLY=false`.

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
  --set context=my-context \
  --set readOnly=true \
  --set rbac.mode=readonly
```

To allow operator actions through Helm, make both settings explicit:

```bash
helm upgrade --install northstar ./helm/northstar \
  --namespace northstar --create-namespace \
  --set image.repository=registry.example.com/northstar \
  --set image.tag=latest \
  --set context=my-context \
  --set readOnly=false \
  --set rbac.mode=operator
```

The chart creates a ServiceAccount, ClusterRole, ClusterRoleBinding, Deployment, and Service. The default role is read-only. Review the operator role before using it in production.

## Local demo

The local Docker-backed demo remains available:

```bash
npm run start:all
```

If port 5173 or 9090 is already occupied, Northstar automatically selects the next available port and updates its Prometheus scrape target.
