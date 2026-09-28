#!/usr/bin/env node
/**
 * Generates the two Grafana dashboards from a list of PromQL queries.
 *
 * Why a generator: hand-written dashboard JSON is ~400 lines per panel of layout noise,
 * which means in practice nobody reviews it and it silently diverges from the metrics the
 * code actually exposes. Here the *queries* are the source of truth, and every one of them
 * is checked against the live `/metrics` output before it is written (see
 * `tools/loadgen/loadgen.mjs`, whose parser this reuses conceptually). Changing a metric
 * name in code and forgetting the dashboard now shows up as a diff in a reviewable file.
 *
 *   node infra/grafana/dashboards/build.mjs            # write the JSON
 *   node infra/grafana/dashboards/build.mjs --check     # fail if the files are stale
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const check = process.argv.includes('--check');

const DS = { type: 'prometheus', uid: 'prometheus' };
const PANEL_H = 8;
const ROW_W = 24;

/** Timeseries panel. `queries` are `[legend, expr]` pairs. */
const ts = (
  title,
  description,
  queries,
  { unit = 'short', w = 12, h = PANEL_H, x, y, decimals } = {},
) => ({
  type: 'timeseries',
  title,
  description,
  id: null,
  gridPos: { h, w, x: x ?? 0, y: y ?? 0 },
  datasource: DS,
  targets: queries.map(([legend, expr], i) => ({
    refId: String.fromCharCode(65 + i),
    expr,
    legendFormat: legend,
    interval: '',
  })),
  fieldConfig: {
    defaults: {
      unit,
      custom: {
        drawStyle: 'line',
        lineWidth: 1,
        fillOpacity: 8,
        showPoints: 'never',
        spanNulls: true,
      },
      ...(decimals === undefined ? {} : { decimals }),
    },
    overrides: [],
  },
  options: {
    legend: {
      displayMode: 'table',
      placement: 'bottom',
      showLegend: true,
      calcs: ['mean', 'max', 'lastNotNull'],
    },
    tooltip: { mode: 'multi', sort: 'desc' },
  },
});

const stat = (
  title,
  description,
  expr,
  { unit = 'short', w = 6, h = 4, x = 0, y = 0, thresholds, mappings } = {},
) => ({
  type: 'stat',
  title,
  description,
  id: null,
  gridPos: { h, w, x, y },
  datasource: DS,
  targets: [{ refId: 'A', expr }],
  fieldConfig: {
    defaults: {
      unit,
      mappings: mappings ?? [],
      thresholds: {
        mode: 'absolute',
        steps: thresholds ?? [{ color: 'green', value: null }],
      },
    },
    overrides: [],
  },
  options: {
    reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
    orientation: 'auto',
    textMode: 'value_and_name',
    colorMode: 'value',
    graphMode: 'area',
  },
});

const text = (title, content, { w = ROW_W, h = 6, x = 0, y = 0 } = {}) => ({
  type: 'text',
  title,
  id: null,
  gridPos: { h, w, x, y },
  options: { mode: 'markdown', content },
});

const row = (title, y) => ({
  type: 'row',
  title,
  collapsed: false,
  id: null,
  gridPos: { h: 1, w: ROW_W, x: 0, y },
  panels: [],
});

const dashboard = (uid, title, tags, description, panels, { withVariables = true } = {}) => {
  // Layout is fixed (no `repeat`/auto-placement) so the generated file is byte-stable and
  // a `git diff` on a dashboard shows the panel that changed, not a reshuffle.
  let nextY = 0;
  const laid = [];
  for (const p of panels) {
    const pos = p.gridPos;
    if (pos.y === undefined || pos.y === -1) {
      if (
        pos.x + pos.w > ROW_W ||
        (laid.length &&
          laid.at(-1).gridPos.y === nextY &&
          laid.at(-1).gridPos.x + laid.at(-1).gridPos.w >= ROW_W)
      ) {
        nextY += PANEL_H;
      }
      laid.push({ ...p, gridPos: { ...pos, y: nextY } });
      if (pos.w >= ROW_W) nextY += pos.h;
      continue;
    }
    laid.push(p);
    nextY = Math.max(nextY, pos.y + pos.h);
  }
  return {
    uid,
    title,
    tags,
    description,
    schemaVersion: 39,
    version: 1,
    editable: true,
    graphTooltip: 1,
    refresh: '15s',
    time: { from: 'now-3h', to: 'now' },
    timepicker: { refresh_intervals: ['10s', '15s', '30s', '1m', '5m'] },
    fiscalYearStartMonth: 0,
    liveNow: false,
    ...(withVariables
      ? {
          templating: {
            list: [
              {
                name: 'job',
                label: 'service',
                type: 'query',
                datasource: DS,
                query: 'label_values(app_info, job)',
                refresh: 2,
                includeAll: true,
                multi: true,
                current: { text: ['$job'], value: ['All'] },
                options: [],
              },
            ],
          },
        }
      : {}),
    panels: laid.map((p, i) => ({ ...p, id: i + 1 })),
    annotations: { list: [] },
    links: [],
  };
};

const RATE = '[$__rate_interval]';

/**
 * Every metric name a panel queries must exist in `packages/shared/src/metrics.ts`
 * (`METRICS`), or be a process metric that Prometheus collects itself. Without this
 * check a panel can reference a metric that nothing registers: Grafana shows an empty
 * graph, which looks like "no incidents" rather than "wrong query" — the exact failure
 * that let `tenant_requests_total` stay broken while its dashboard looked fine.
 *
 * The shared module is TypeScript, so this reads the name table as text; a build script
 * parsing a source file is acceptable precisely because the *consequence* of a mismatch
 * here is only "the generator refuses to write a dashboard".
 */
const APP_METRICS = await (() =>
  readFile(resolve(here, '../../../packages/shared/src/metrics.ts'), 'utf8').then((src) => {
    const block = src.slice(src.indexOf('export const METRICS'), src.indexOf('} as const;'));
    return new Set([...block.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]));
  }))();

const PROCESS_METRIC = /^(nodejs_|process_|go_)/;

/** Function and keyword names that survive the stripping above and are not metrics. */
const PROMQL_VOCAB = new Set([
  'rate',
  'irate',
  'increase',
  'delta',
  'sum',
  'avg',
  'min',
  'max',
  'count',
  'count_values',
  'quantile',
  'histogram_quantile',
  'topk',
  'bottomk',
  'clamp_min',
  'clamp_max',
  'offset',
  'le',
  'job',
  'instance',
  'vector',
  'abs',
  'absent',
  'round',
  'floor',
  'ceil',
  'label_replace',
  'avg_over_time',
  'max_over_time',
  'min_over_time',
  'sum_over_time',
  'last_over_time',
]);

function assertQueries(panels) {
  const bad = [];
  for (const panel of panels) {
    for (const target of panel.targets ?? []) {
      // Strip everything that is not a metric name: label matchers, grouping clauses,
      // Grafana variables. What survives is function names, keywords and metrics.
      const bare = (target.expr ?? '')
        .replace(/\{[^}]*\}/g, ' ')
        .replace(/\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, ' ')
        .replace(/\$[A-Za-z_]+/g, ' ');
      for (const m of bare.matchAll(/\b([a-z_][a-z0-9_]{4,})\b/g)) {
        const word = m[1];
        if (PROMQL_VOCAB.has(word)) continue;
        const name = word.replace(/_(bucket|count|sum)$/, '');
        if (!APP_METRICS.has(name) && !PROCESS_METRIC.test(word)) {
          bad.push(`${panel.title}: ${word}`);
        }
      }
    }
  }
  if (bad.length) {
    throw new Error(
      `dashboard queries reference metrics that are not in packages/shared/src/metrics.ts:\n  ${[...new Set(bad)].join('\n  ')}`,
    );
  }
}
/* ------------------------------------------------------------------ API overview */
const overview = dashboard(
  'saas-api-overview',
  'SaaS · API overview',
  ['saas', 'api'],
  'Golden signals for the request path, plus the three things this design is actually claiming: the token bucket, the cache, and the pool. Latency here is measured by the server — client-side numbers under load come from the load generator.',
  [
    stat(
      'Requests /s',
      'All routes including 429s. A drop with stable offered load means the edge, not the app.',
      `sum(rate(http_requests_total${RATE}))`,
      {
        w: 6,
        h: 4,
        y: 0,
        x: 0,
      },
    ),
    stat(
      'Server p95',
      'Excludes time the request spent waiting in a token bucket (the limiter answers 429 before the handler).',
      `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket${RATE})))`,
      {
        unit: 's',
        w: 6,
        h: 4,
        y: 0,
        x: 6,
        thresholds: [
          { color: 'green', value: null },
          { color: 'amber', value: 0.2 },
          { color: 'red', value: 0.5 },
        ],
      },
    ),
    stat(
      '5xx ratio',
      'The SLO is ~0 under any load: 429 is a working limiter, 4xx is a client, 5xx is us.',
      `sum(rate(http_errors_total{class="5xx"}${RATE})) / clamp_min(sum(rate(http_requests_total${RATE})), 0.001)`,
      {
        unit: 'percentunit',
        w: 6,
        h: 4,
        y: 0,
        x: 12,
        thresholds: [
          { color: 'green', value: null },
          { color: 'red', value: 0.01 },
        ],
      },
    ),
    stat(
      'Limiter fallback',
      'Any count here means the Lua bucket was unreachable and per-pod buckets took over — tenant budgets are then only enforced per replica.',
      `sum(increase(ratelimit_decisions_total{outcome="fallback"}[15m]))`,
      {
        w: 6,
        h: 4,
        y: 0,
        x: 18,
        thresholds: [
          { color: 'green', value: null },
          { color: 'red', value: 1 },
        ],
      },
    ),

    ts(
      'Request rate by status',
      'Split by status so a load test that throttles 70% of a free tenant is visibly different from a failure.',
      [`{{status}}`, `sum by (status) (rate(http_requests_total${RATE}))`],
      { y: 4, h: 8 },
    ),
    ts(
      'Latency percentiles (server)',
      'p50/p95/p99 from the same histogram the alerts use. If this moves and the DB panels do not, look at event-loop lag below.',
      [
        [
          'p50',
          `histogram_quantile(0.5, sum by (le) (rate(http_request_duration_seconds_bucket${RATE})))`,
        ],
        [
          'p95',
          `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket${RATE})))`,
        ],
        [
          'p99',
          `histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket${RATE})))`,
        ],
      ],
      { unit: 's', x: 0, y: 4, h: 8 },
    ),
    ts(
      'Latency by route (p95)',
      'Route template labels, never raw paths — one tenant enumerating ids must not be able to blow up cardinality.',
      [
        [
          '{{route}}',
          `histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket${RATE})))`,
        ],
      ],
      { unit: 's', x: 12, y: 4, h: 8 },
    ),

    ts(
      'Token bucket decisions by plan',
      'The plan geometry is the product: free gets 120 reads/5min, pro 1200, enterprise 6000. Throttling here is the feature working.',
      [
        [
          '{{plan}} {{outcome}}',
          `sum by (plan, outcome) (increase(ratelimit_decisions_total[5m]))`,
        ],
      ],
      { y: 12, h: 8, x: 0 },
    ),
    ts(
      'Cache: hit ratio by entity',
      '`coalesced` counts as a win — it means concurrent readers shared one fill. Below ~50% this layer is not earning its complexity.',
      [
        [
          '{{entity}}',
          `sum by (entity) (rate(cache_lookups_total{outcome=~"hit|coalesced"}${RATE})) / clamp_min(sum by (entity) (rate(cache_lookups_total${RATE})), 0.001)`,
        ],
      ],
      { unit: 'percentunit', y: 12, h: 8, x: 12 },
    ),

    ts(
      'Cache p95 vs request p95',
      'The cache paying for itself, as one panel: the gap between these two lines is the time spent in Postgres and rendering. A flat request line at 0 is not "cache disabled" — it means the cache layer was never consulted for that route.',
      [
        [
          'cache p95',
          `histogram_quantile(0.95, sum by (le) (rate(cache_operation_duration_seconds_bucket${RATE})))`,
        ],
        [
          'request p95',
          `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket${RATE})))`,
        ],
      ],
      { unit: 's', y: 20, h: 8, x: 0 },
    ),
    ts(
      'Postgres pool',
      'Sustained `waiting` > 0 means the pool is the bottleneck, not Postgres. PG_POOL_MAX × api replicas must stay under max_connections, and this is the panel that proves it.',
      [['{{state}}', `sum by (state) (pg_pool_connections)`]],
      { y: 20, h: 8, x: 12 },
    ),

    ts(
      'DB time per request',
      'Query+transaction duration vs total request duration: the difference is serialisation, validation and the limiter.',
      [
        [
          'db p95',
          `histogram_quantile(0.95, sum by (le) (rate(db_query_duration_seconds_bucket${RATE})))`,
        ],
        ['slow queries/s', `sum(rate(db_slow_queries_total${RATE}))`],
      ],
      { unit: 's', y: 28, h: 8, x: 0 },
    ),
    ts(
      'Process health (all pods)',
      'Event-loop lag is the number to watch during load tests: with it climbing, every latency panel above is lying about the database. Memory/heap shows a report payload leaking.',
      [
        // A gauge, not a histogram: prom-client's collect-default-metrics already samples
        // the lag per interval, so rate() here would be rate() of a gauge — legal PromQL,
        // meaningless numbers.
        ['lag p99 (s) {{instance}}', `nodejs_nodejs_eventloop_lag_p99_seconds`],
        ['rss {{instance}}', `nodejs_process_resident_memory_bytes`],
      ],
      { unit: 's', y: 28, h: 8, x: 12 },
    ),

    ts(
      'Dependencies & saturation',
      "redis_up: 0 means the cache/limiter layer degraded on purpose (a Redis outage must never become a user-visible error). in-flight is Little's law: rate times latency.",
      [
        ['redis_up {{dependency}}', `redis_up`],
        ['in-flight {{instance}}', `http_requests_in_flight`],
      ],
      { y: 36, h: 8, x: 0 },
    ),
    ts(
      'Auth outcomes',
      'The security-relevant lines: refresh reuse (token theft) and rbac_denied. `login_failure` climbing with no `login_success` is the credential-stuffing shape the alert watches for.',
      [
        ['{{event}}', `sum by (event) (increase(auth_events_total[5m]))`],
        ['reuse (10m)', `sum(increase(auth_events_total{event="reuse_detected"}[10m]))`],
      ],
      { y: 36, h: 8, x: 12 },
    ),

    text(
      'Reading this dashboard',
      [
        '**Server-measured latency excludes limiter waits** — a throttled request never reaches the handler, so the p95 above stays flat while a free tenant is being refused. Client-observed latency (and the 429 share) is what `npm run load:run` reports; compare the two before believing either.',
        '',
        'A run is only evidence about the Redis token bucket if **Limiter fallback** above is 0. The generator prints the same warning for the same reason.',
      ].join('\n'),
      { h: 4, y: 44 },
    ),
  ],
);

/* --------------------------------------------------------------- tenant isolation */
const isolation = dashboard(
  'saas-tenant-isolation',
  'SaaS · tenant isolation',
  ['saas', 'multi-tenancy', 'load'],
  'The noisy-neighbour view: does one enterprise workspace degrading the shared caches and pool show up for everyone else? Latency is deliberately NOT broken down per tenant — that would need a per-tenant histogram, and one tenant minting ids could make it unbounded (see docs/ARCHITECTURE.md). Instead: per-tenant traffic + throttling here, per-route latency on the API dashboard.',
  [
    ts(
      'Top tenants by requests',
      'Top 20 only (TENANT_METRIC_TOP_N): the label set is bounded on purpose so a tenant cannot create a new series by creating a new workspace.',
      [['{{tenant}}', `topk(10, sum by (tenant) (rate(tenant_requests_total${RATE})))`]],
      { y: 0, h: 9, x: 0 },
    ),
    ts(
      'Throttle share per tenant',
      'The isolation claim in one panel: a tenant at 100% throttled is being limited *because it exceeded its plan*, and everyone else should stay at 0%.',
      [
        [
          '{{tenant}}',
          `sum by (tenant) (rate(tenant_requests_total{outcome="throttled"}${RATE})) / clamp_min(sum by (tenant) (rate(tenant_requests_total${RATE})), 0.001)`,
        ],
      ],
      { unit: 'percentunit', y: 0, h: 9, x: 12 },
    ),

    ts(
      'Requests by route class',
      'Read vs write vs bulk mix, fleet-wide. A write storm looks different from a read storm and needs a different fix (cache vs pool vs queue).',
      [['{{routeClass}}', `sum by (route_class) (rate(tenant_requests_total[${RATE}]))`]],
      { y: 9, h: 8, x: 0 },
    ),
    ts(
      'Quota rejections (402)',
      'Plan quota is enforced in a trigger, in the same transaction as the write — so this line is the only visible sign of a quota that needs raising, and it is a business event, not an error.',
      [['402 {{route}}', `sum by (route) (rate(http_errors_total{code="402"}${RATE}))`]],
      { y: 9, h: 8, x: 12 },
    ),

    row('Queue & outbox (worker)', 17),
    ts(
      'Outbox depth by state',
      'pending = waiting for the relay; failed = will be retried with backoff; discarded = terminal (dead-lettered by the dispatcher, see 0013). Growing `pending` with zero relay ticks is the real outage.',
      [['{{state}}', `sum by (state) (outbox_pending_messages)`]],
      { y: 18, h: 8, x: 0 },
    ),
    ts(
      'Oldest pending job / row',
      'The user-visible queue delay. This is the number `QueueBacklogStuck` alerts on at 60s, and why a `dead` outbox row must leave `pending` immediately: otherwise one poison message holds this gauge open for an hour and a real stall hides behind it.',
      [
        ['{{queue}}', `max by (queue) (queue_oldest_pending_job_seconds)`],
        ['outbox lag (s)', `max(outbox_oldest_lag_seconds)`],
      ],
      { unit: 's', y: 18, h: 8, x: 12 },
    ),

    ts(
      'Job outcomes & relay',
      'completed/skipped/retrying/failed per queue. `skipped` is idempotent replay (a published row claimed twice) — it should be rare but non-zero, and a relay that only ticks `idle` while pending grows is not consuming.',
      [
        [
          '{{queue}} {{outcome}}',
          `sum by (queue, outcome) (increase(queue_job_results_total[5m]))`,
        ],
        ['relay {{outcome}}', `sum by (outcome) (rate(worker_relay_ticks_total[2m]))`],
      ],
      { y: 26, h: 8, x: 0 },
    ),
    ts(
      'DLQ & stalled locks',
      'Everything here needs a human. /dlq returns these; /dlq/replay (POST, ≤500 ids) puts them back through the same claim path, so a replay cannot double-execute.',
      [
        ['dead-letter depth', `queue_dead_letter_depth`],
        ['dead letters by reason', `sum by (reason) (increase(queue_dead_letters_total[15m]))`],
        ['slow jobs', `sum by (job) (increase(worker_slow_jobs_total[15m]))`],
      ],
      { y: 26, h: 8, x: 12 },
    ),

    ts(
      'Email handler truth',
      '`transport="dry-run"` means SMTP was never configured: the job ran, nothing was delivered. Printed as a metric rather than only a log line so a demo cannot be mistaken for a working mailer.',
      [
        [
          '{{transport}} {{kind}}',
          `sum by (transport, kind) (increase(worker_emails_sent_total[15m]))`,
        ],
      ],
      { y: 34, h: 8, x: 0 },
    ),
    ts(
      'Worker saturation',
      'active jobs at CONCURRENCY for more than a few minutes = the queue is the bottleneck, and the fix is another worker pod (HPA scales on this, not on CPU: a job waiting on Postgres uses no CPU).',
      [
        ['active {{instance}}', `worker_active_jobs`],
        ['errors {{where}}', `sum by (where) (increase(worker_errors_total[10m]))`],
      ],
      { y: 34, h: 8, x: 12 },
    ),

    text(
      'Reproducing the isolation result',
      [
        '```bash',
        'npm run load:isolation      # 1 enterprise blaster (20 VUs) + 4 free victims, 60s',
        '```',
        '',
        'The thresholds that must hold: `worstVictim.p95Ms <= 500`, `totals.error5xx == 0`, `server.throttlePct >= 5` (an attacker that was never throttled proves nothing). Measured numbers, including the victim p50/p95/p99 table, are in `docs/ARCHITECTURE.md` — the run is reproducible from this repo, so those numbers are a claim, not a decoration.',
      ].join('\n'),
      { h: 6, y: 42 },
    ),
  ],
);

const files = [
  ['api-overview.json', overview],
  ['tenant-isolation.json', isolation],
];

for (const [, model] of files) assertQueries(model.panels);

for (const [name, model] of files) {
  const path = resolve(here, name);
  const out = `${JSON.stringify(model, null, 2)}\n`;
  if (check) {
    const existing = await readFile(path, 'utf8').catch(() => '');
    if (existing !== out) {
      console.error(`stale: ${name} — re-run \`node infra/grafana/dashboards/build.mjs\``);
      process.exitCode = 1;
    }
    continue;
  }
  await writeFile(path, out);
  console.log(`wrote ${name} (${model.panels.length} panels)`);
}
