# Demo environment

## One command

```bash
docker compose up --build
```

Open [http://localhost:5173](http://localhost:5173). The demo includes three simulated contexts, workloads, pod logs, events, alerts, resource views, dashboards, and Prometheus wiring. No kubeconfig or Kubernetes cluster is required.

Stop it with `Ctrl-C`, or run `docker compose down`.

## Sample Kubernetes cluster

For a real local cluster, install [kind](https://kind.sigs.k8s.io/) and run:

```bash
kind create cluster --name northstar-demo
kubectl apply -f k8s/northstar-demo.yaml
kubectl apply -f k8s/dev-demo.yaml
NORTHSTAR_MODE=kubernetes NORTHSTAR_CONTEXT=kind-northstar-demo npm start
```

The deliberately broken `feature-preview` workload gives the incident timeline a useful warning event. Delete the cluster with `kind delete cluster --name northstar-demo`.
