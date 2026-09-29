# Monitoring on Kubernetes

The compose lab (`infra/prometheus/`, `infra/grafana/`) and this directory
monitor the **same targets on the same ports** with the **same alert rules**,
because a metric that only exists in one environment is how an alert is
discovered to be broken during the incident it was written for.

| What          | Compose                                               | Kubernetes                                                               |
| ------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| Scrape config | `dns_sd_configs` on `api:9464` / `worker:9465`        | ServiceMonitors below                                                    |
| Alert rules   | `infra/prometheus/alerts.yml`                         | `prometheusrule.yaml` (same expressions)                                 |
| Dashboards    | `infra/grafana/dashboards/`                           | same files, provisioned by the Grafana operator or the same volume mount |
| Scrape path   | `/metrics` (internal listener, never the public port) | same                                                                     |

## Applying

These resources require the [prometheus-operator](https://prometheus-operator.dev/)
CRDs (installed by kube-prometheus-stack). If your cluster scrapapes by
annotation instead, the Deployments already carry `prometheus.io/*` annotations
pointing at the same 9464/9465 ports — delete nothing, both mechanisms coexist.

The `release: kube-prometheus-stack` label on the ServiceMonitors must match
whatever your Helm release is actually called — that label is how the operator's
Prometheus selects monitors, and a mismatch produces a green Prometheus with
zero targets. Check with:

```sh
kubectl get prometheus -A -o jsonpath='{.items[*].spec.serviceMonitorSelector}'
```
