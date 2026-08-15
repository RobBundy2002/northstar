# Security model and threat mitigations

Northstar is an operator endpoint. Its primary security boundary is the Node server, not the browser UI.

## Threats and mitigations

| Threat | Mitigation |
| --- | --- |
| Malicious browser request | Validate resource names and exec commands server-side; never trust disabled UI controls. |
| Accidental production deletion | Production-context actions require explicit confirmation at the API boundary. |
| Unauthorized Kubernetes operation | Kubernetes mode preflights actions with `kubectl auth can-i`; the cluster RBAC policy remains authoritative. |
| Read-only bypass | `NORTHSTAR_READ_ONLY=true` returns `403` for mutating actions, exec, and port-forward operations. |
| Unauthorized exec | Exec is separately guarded, command operators are rejected, and Kubernetes RBAC is checked for `pods/exec`. |
| Overly privileged ServiceAccount | Helm defaults to read-only RBAC; operator RBAC is a separate, explicit profile. |
| Compromised kubeconfig | Mount kubeconfig read-only, use a scoped context, and keep real-cluster Compose bound to localhost. |
| Exposed operator endpoint | Put Northstar behind authenticated HTTPS when remote access is needed; do not expose the raw endpoint publicly. |
| Missing accountability | Action attempts, denials, RBAC failures, and exec/port-forward activity are appended to `data/audit.jsonl` and exposed through `/api/audit`. |

## Audit event example

```json
{"timestamp":"2026-08-15T10:05:00.000Z","actor":"local-operator","action":"delete","context":"production-east","namespace":"northstar","resource":"pod/payments-api","outcome":"denied","reason":"production-confirmation-required"}
```

Audit logs are intentionally simple JSONL so they can be shipped by a host collector. They are not a replacement for Kubernetes audit logging or a full identity provider.
