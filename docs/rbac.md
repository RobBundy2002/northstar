# RBAC examples

Northstar ships two Kubernetes profiles:

```bash
kubectl apply -f k8s/northstar-readonly-rbac.yaml
kubectl apply -f k8s/northstar-operator-rbac.yaml
```

Use the read-only profile with `NORTHSTAR_READ_ONLY=true` (the default for real-cluster Compose and Helm deployments). Use the operator profile only when rollout, scale, resource, delete, exec, or port-forward actions are explicitly needed and the kubeconfig is scoped to the intended clusters.

Review the exact permissions in [northstar-readonly-rbac.yaml](../k8s/northstar-readonly-rbac.yaml) and [northstar-operator-rbac.yaml](../k8s/northstar-operator-rbac.yaml) before applying them. The application also enforces read-only mode at its API boundary.
