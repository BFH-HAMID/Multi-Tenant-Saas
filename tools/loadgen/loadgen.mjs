#!/usr/bin/env node
/**
 * Dependency-free load generator for the multi-tenant API.
 *
 * Why this exists next to k6 rather than instead of it: the point of the load
 * tests in this repo is to *falsify* the latency and isolation claims in
 * docs/ARCHITECTURE.md, and a claim nobody can run is decoration. k6 is the tool
 * for CI and for browser-realistic client behaviour (`--emit-k6` writes an
 * equivalent script from the same config, so the two never drift by hand). But a
 * reviewer on a laptop — or a CI runner without a k6 image — should still be able
 * to produce the numbers, so the core uses nothing but Node's http/https.
 *
 * Design decisions that affect what the numbers mean:
 *
 *   - **Closed-loop VUs with pacing.** Each virtual user issues a request, waits
 *     for it, thinks, then repeats. That is how a browser or an integration
 *     behaves, and it is why a saturated backend shows up as rising latency
 *     (what we alert on) instead of dropped load. `rpsPerVu` paces it so a
 *     capacity run is comparable to a throughput run.
 *   - **Weights, not phases.** A scenario mix is per-request weighted choice, so
 *     the mix holds at any rate and a slow route cannot steal load from a fast
 *     one (a phase-based script does exactly that, and hides tail latency).
 *   - **Client AND server percentiles.** The client measures what a user feels
 *     (including socket queueing); the API's own histogram is read from
 *     `/metrics` before and after, and a percentile is interpolated inside the
 *     bucket it lands in. A large gap between the two is admission control or
 *     the event loop, not the handler — which is the thing a reviewer needs to
 *     see when "p99 is fine in the handler but users wait 2s".
 *   - **Per-tenant, always.** Isolation is the product. Every number is reported
 *     per tenant with its plan, so "the noisy neighbour was throttled and the
 *     victims were not" is a measured statement, not a hope.
 *
 * Exit code is 0 only if every threshold holds, so this file is usable as a CI
 * gate as well as a measurement tool.
 */
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}
const configPath = args.config ?? 'loadtests/load.config.json';
const cfg = JSON.parse(await readFile(configPath, 'utf8'));
const baseUrl = args.baseUrl ?? cfg.baseUrl ?? 'http://127.0.0.1:3000';
const metricsUrl = args.metricsUrl ?? cfg.metricsUrl ?? 'http://127.0.0.1:9464/metrics';
const durationMs = parseDuration(args.duration ?? String(cfg.duration ?? '30s'));
const rampMs = parseDuration(String(cfg.rampUp ?? '2s'));
const seedPassword = cfg.seedPassword ?? 'Seed-Passw0rd-2026!';
const startedAt = new Date();

class HttpError extends Error {
  constructor(message, { status, body }) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const agent = new (baseUrl.startsWith('https') ? https.Agent : http.Agent)({
  keepAlive: true,
  // Sized per VU: an exhausted agent pool would add its own queueing to the
  // latency we are trying to measure, which is the classic way to make a load
  // generator lie about the system under test.
  maxSockets: Number(cfg.vus ?? 25) * 2,
  keepAliveMsecs: 5_000,
});

/** One request, measured from socket-pick to last byte, with no retries. */
function request({ method = 'GET', path, headers = {}, body, timeoutMs = 15_000 }) {
  const url = new URL(path, baseUrl);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const req = (url.protocol === 'https:' ? https : http).request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        agent,
        headers: {
          accept: 'application/json',
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const ms = Number(process.hrtime.bigint() - started) / 1e6;
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            ms,
            json: () => {
              try {
                return JSON.parse(text);
              } catch {
                return undefined;
              }
            },
            text,
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new HttpError('client timeout', { status: 0, body: '' })));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function probe(url) {
  return new Promise((resolve) => {
    const req = (url.startsWith('https') ? https : http).get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', () => resolve({ status: 0, text: '' }));
    req.setTimeout(3000, () => req.destroy());
  });
}

// ---------------------------------------------------------------- tenants ----

/**
 * A tenant under load is a *real* tenant: registered through the public signup
 * path (or logged into, when `useSeed` names an existing workspace), holding a
 * live access token. Nothing here fabricates a JWT — a load test that skips the
 * auth funnel is measuring a different system than production runs.
 */
/**
 * Setup requests (register/login) retry on 429 and honour `retry-after`. Without
 * this, a second load run started right after the first spends its setup inside the
 * per-IP auth brake and dies with "register failed (429)" — an artifact of the
 * generator hammering its own guard, not a property of the system under test. The
 * measured requests are never retried: a 429 there is the result we want.
 */
async function requestAllowThrottled(opts, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    const res = await request(opts);
    if (res.status !== 429) return res;
    const waitMs = Math.min(20_000, Number(res.headers['retry-after'] ?? 2) * 1_000 + 250);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  throw new Error(`setup still throttled after ${attempts} attempts`);
}

async function makeTenant(spec, index) {
  const runTag = `${Date.now().toString(36)}${index}`;
  if (spec.useSeed) {
    const email = `${spec.user ?? 'owner'}@${spec.useSeed}.test`;
    const res = await requestAllowThrottled({
      method: 'POST',
      path: '/v1/auth/login',
      body: { email, password: spec.password ?? seedPassword, tenantSlug: spec.useSeed },
    });
    if (res.status !== 200) {
      throw new HttpError(`login failed for ${email}`, { status: res.status, body: res.text });
    }
    const t = res.json() ?? {};
    return {
      label: spec.useSeed,
      slug: spec.useSeed,
      plan: spec.plan ?? 'pro',
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
    };
  }
  const slug = `${cfg.slugPrefix ?? 'load'}-${runTag}`;
  const email = `owner@${slug}.test`;
  const password = spec.password ?? 'Load-Test-Passw0rd-2026!';
  const res = await requestAllowThrottled({
    method: 'POST',
    path: '/v1/auth/register',
    body: {
      tenant: { name: `Load ${slug}`, slug, plan: spec.plan ?? 'free' },
      user: { email, password, displayName: 'Load Runner' },
    },
  });
  if (res.status !== 201) {
    throw new HttpError(`register failed (${res.status})`, { status: res.status, body: res.text });
  }
  const t = res.json() ?? {};
  return {
    label: slug,
    slug,
    plan: spec.plan ?? 'free',
    password,
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    projects: [],
    jobs: [],
  };
}

/**
 * Seed the workspace so reads have something to read. A load test against an
 * empty dataset measures `count(*)` on cold pages, not the query plan anyone will
 * actually run — the projects table needs rows, and the id/list cache needs keys.
 */
async function seedProjects(tenant, count) {
  for (let i = 0; i < count; i++) {
    const res = await request({
      method: 'POST',
      path: '/v1/projects',
      headers: {
        authorization: `Bearer ${tenant.accessToken}`,
        'idempotency-key': `load-${tenant.slug}-${i}`,
      },
      body: { name: `Load project ${i}`, tags: ['load'] },
    });
    if (res.status === 201) tenant.projects?.push(res.json().id);
    else if (res.status === 402)
      break; // quota: the plan limit is being measured, not bypassed
    else if (res.status >= 500)
      throw new HttpError(`seed failed (${res.status})`, { status: res.status, body: res.text });
  }
}

// ------------------------------------------------------------ scenarios ----

/** Resolve a `${...}` template in a scenario path against the tenant context. */
/**
 * Path templates: `{slug}`, `{project}`, `{job}`. `{job}` falls back to a project
 * id while the run has not enqueued anything yet, which yields an honest 404 from
 * the status route for the first second rather than a skipped sample — a scenario
 * that quietly vanishes from the mix when its prerequisite is missing is how a
 * load test stops covering the thing it was written to cover.
 */
function expand(template, tenant) {
  const pick = (list) =>
    list.length ? String(list[Math.floor(Math.random() * list.length)]) : undefined;
  return template
    .replace(/\{slug\}/g, tenant.slug)
    .replace(/\{project\}/g, () => pick(tenant.projects ?? []) ?? randomUUID())
    .replace(
      /\{job\}/g,
      () => pick(tenant.jobs ?? []) ?? pick(tenant.projects ?? []) ?? randomUUID(),
    );
}

function pickScenario(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

// ------------------------------------------------------------- metrics ----

/**
 * Minimal Prometheus text parser: we only need sample sums and histogram buckets.
 * Written by hand because adding a dependency to a dev tool means every reviewer
 * installs something to check a claim.
 */
function parsePrometheus(text) {
  const series = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const brace = line.indexOf('{');
    const space = line.lastIndexOf(' ');
    if (space < 0) continue;
    const value = Number(line.slice(space + 1));
    if (!Number.isFinite(value)) continue;
    let name;
    let labels = '';
    if (brace === -1) {
      name = line.slice(0, space);
    } else {
      name = line.slice(0, brace);
      labels = line.slice(brace + 1, line.lastIndexOf('}'));
    }
    series.set(`${name}|${labels}`, value);
  }
  return series;
}

/**
 * Which implementation of the cache and limiter the process is *actually* talking to,
 * read off `app_info`. `cache="memory"` means the in-process doubles in
 * packages/shared answered instead of Redis: the same interface and the same bucket
 * arithmetic, but single-pod semantics and no Lua script. Latency from such a run is
 * still evidence about the request path (routing, RLS queries, serialisation, the pool)
 * and no evidence at all about Redis round-trips — and nothing else in the report would
 * tell a reader which of the two they are looking at, so it is printed as a warning.
 */
function backendOf(series, name = 'app_info') {
  for (const key of series.keys()) {
    const [metric, labels] = key.split('|', 2);
    if (metric !== name) {
      continue;
    }
    const parsed = labelsFromString(labels);
    if (parsed && Object.keys(parsed).length > 0) {
      return parsed;
    }
  }
  return {};
}

function sumMatching(series, name, filter = () => true) {
  let total = 0;
  for (const [key, value] of series) {
    const [metric, labels] = key.split('|', 2);
    if (metric !== name) continue;
    if (!filter(labelsFromString(labels))) continue;
    total += value;
  }
  return total;
}

function labelsFromString(s) {
  const out = {};
  const re = /(\w+)="((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(s)) !== null) out[m[1]] = m[2];
  return out;
}

/**
 * Percentile from cumulative histogram buckets, linearly interpolated inside the
 * chosen bucket. Optimistic for the top bucket (no +Inf upper bound to
 * interpolate against) — which is why the client-side percentiles are reported
 * alongside, and why a report where the two disagree deserves a look.
 */
function bucketPercentile(series, name, q, extraLabelFilter = () => true) {
  const buckets = [];
  for (const [key, value] of series) {
    const [metric, labels] = key.split('|', 2);
    if (metric !== `${name}_bucket`) continue;
    const l = labelsFromString(labels);
    if (!extraLabelFilter(l)) continue;
    buckets.push({
      le: l.le === '+Inf' ? Number.POSITIVE_INFINITY : Number(l.le),
      count: value,
      key: labels,
    });
  }
  if (!buckets.length) return null;
  const byLe = new Map();
  for (const b of buckets) byLe.set(b.le, Math.max(byLe.get(b.le) ?? 0, b.count));
  const sorted = [...byLe.entries()].sort((a, b) => a[0] - b[0]);
  const total = sorted.at(-1)?.[1] ?? 0;
  if (!total) return null;
  const target = total * q;
  let prevLe = 0;
  let prevCount = 0;
  for (const [le, count] of sorted) {
    if (count >= target) {
      if (!Number.isFinite(le)) return prevLe;
      const span = count - prevCount || 1;
      const frac = (target - prevCount) / span;
      return prevLe + (le - prevLe) * frac;
    }
    prevLe = le;
    prevCount = count;
  }
  return prevLe;
}

// --------------------------------------------------------------- running ----

class Samples {
  constructor() {
    this.latency = [];
    this.count = 0;
    this.byStatus = new Map();
  }
  add(ms, status) {
    this.count += 1;
    this.latency.push(ms);
    this.byStatus.set(status, (this.byStatus.get(status) ?? 0) + 1);
  }
  get errors() {
    let n = 0;
    for (const [status, count] of this.byStatus) if (status >= 500) n += count;
    return n;
  }
  get clientErrors() {
    let n = 0;
    for (const [status, count] of this.byStatus) if (status >= 400 && status < 500) n += count;
    return n;
  }
  get throttled() {
    return this.byStatus.get(429) ?? 0;
  }
  percentile(q) {
    if (!this.latency.length) return 0;
    const s = Float64Array.from(this.latency).sort();
    const idx = Math.min(s.length - 1, Math.ceil(q * s.length) - 1);
    return Number(s[Math.max(0, idx)]);
  }
  get mean() {
    if (!this.latency.length) return 0;
    return this.latency.reduce((a, b) => a + b, 0) / this.latency.length;
  }
  get max() {
    return this.latency.length ? Math.max(...this.latency) : 0;
  }
  summary() {
    return {
      requests: this.count,
      p50Ms: round(this.percentile(0.5)),
      p95Ms: round(this.percentile(0.95)),
      p99Ms: round(this.percentile(0.99)),
      maxMs: round(this.max),
      meanMs: round(this.mean),
      error5xx: this.errors,
      error4xx: this.clientErrors,
      throttled: this.throttled,
      errorRate: this.count ? round(this.errors / this.count, 4) : 0,
      throttleRate: this.count ? round(this.throttled / this.count, 4) : 0,
    };
  }
}

const round = (v, digits = 1) => Number(v.toFixed(digits));

async function run() {
  const tenantSpecs = cfg.tenants ?? [{ count: 1, plan: 'free' }];
  const tenants = [];
  let idx = 0;
  for (const spec of tenantSpecs) {
    for (let i = 0; i < (spec.count ?? 1); i++) {
      tenants.push(await makeTenant(spec, idx++));
    }
  }
  if (cfg.seedProjects) {
    for (const t of tenants)
      await seedProjects(t, typeof cfg.seedProjects === 'number' ? cfg.seedProjects : 5);
  }

  const defaultScenarios = cfg.scenarios ?? [];
  /**
   * A noisy-neighbour experiment needs *different* mixes per workspace, not just
   * different tenants: the attacker is the one with the big plan and no think time,
   * the victims are paced interactive users. `scenariosByPlan` keys by plan id and
   * falls back to `scenarios`, so a plain load config stays one list.
   */
  const byPlan = cfg.scenariosByPlan ?? {};
  const scenarioSets = new Map();
  const weightsFor = (plan) => {
    const list = byPlan[plan] ?? defaultScenarios;
    if (!scenarioSets.has(plan)) {
      scenarioSets.set(plan, { list, weights: list.map((s) => s.weight ?? 1) });
    }
    return scenarioSets.get(plan);
  };
  const perTenant = new Map(tenants.map((t) => [t.label, new Samples()]));
  const allScenarios = [...new Set([...Object.values(byPlan).flat(), ...defaultScenarios])];
  const perScenario = new Map(
    allScenarios.map((s, i) => [s.name ?? `scenario-${i}`, new Samples()]),
  );
  const beforeRaw = await probe(metricsUrl);
  if (beforeRaw.status !== 200) {
    console.log(
      `note: ${metricsUrl} is not reachable (status ${beforeRaw.status}); server-side numbers will be absent.`,
    );
  }
  const before = parsePrometheus(beforeRaw.text);

  let stop = false;
  const onSig = () => {
    stop = true;
    console.log('\nstopping after the current iteration…');
  };
  process.on('SIGINT', onSig);

  const vuLoop = async (vu) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    if (rampMs) await sleep((rampMs * vu) / Math.max(1, Number(cfg.vus ?? 1)));
    while (!stop && Date.now() - runStart < durationMs) {
      const tenant = tenants[vu % tenants.length];
      const { list, weights } = weightsFor(tenant.plan);
      if (!list.length) {
        stop = true;
        throw new Error(
          `no scenarios for plan "${tenant.plan}" (set scenarios or scenariosByPlan)`,
        );
      }
      const scenario = list[pickScenario(weights)];
      const headers = { 'x-load-vu': String(vu) };
      if (tenant.accessToken) headers.authorization = `Bearer ${tenant.accessToken}`;
      if (scenario.idempotency) headers['idempotency-key'] = `load-${vu}-${iterCount(vu)()}`;
      let res;
      try {
        res = await request({
          method: scenario.method ?? 'GET',
          path: expand(scenario.path, tenant),
          headers: { ...headers, ...(scenario.headers ?? {}) },
          body: scenario.body ? expandBody(scenario.body, tenant) : undefined,
        });
      } catch (err) {
        // A refused socket is a result too: silently dropping it would report the
        // best possible p99 exactly when the system is at its worst.
        res = { status: err instanceof HttpError ? err.status : -1, ms: 0 };
      }
      // Record what later scenarios need: the report poll wants a real job id.
      if (res.status === 202 && tenant.jobs && res.json?.().jobId)
        tenant.jobs.push(res.json().jobId);
      perTenant.get(tenant.label)?.add(res.ms ?? 0, res.status);
      perScenario.get(scenario.name ?? 'unnamed')?.add(res.ms ?? 0, res.status);
      const pace =
        (scenario.thinkMs ?? cfg.thinkMs ?? 0) + (scenario.rpsPerVu ? 1000 / scenario.rpsPerVu : 0);
      if (pace) await sleep(pace * (0.8 + Math.random() * 0.4));
    }
  };
  const runStart = Date.now();
  const counters = new Map();
  function iterCount(vu) {
    const next = (counters.get(vu) ?? 0) + 1;
    counters.set(vu, next);
    return () => next;
  }
  function expandBody(body, tenant) {
    const s = JSON.stringify(body);
    return JSON.parse(expand(s, tenant));
  }

  await Promise.all(Array.from({ length: Number(cfg.vus ?? 10) }, (_, i) => vuLoop(i)));
  process.off('SIGINT', onSig);

  const after = parsePrometheus((await probe(metricsUrl)).text);
  const elapsedSec = (Date.now() - runStart) / 1000;

  const counterDelta = (name, filter) =>
    sumMatching(after, name, filter) - sumMatching(before, name, filter);
  const cacheHitInc = counterDelta('cache_lookups_total', (l) => l.outcome === 'hit');
  const cacheTotalInc = counterDelta('cache_lookups_total');
  // The absolute ratio (since boot, not since the run started) is what answers
  // "is the cache working at all"; the delta answers "did this run hit".
  const cacheAbsTotal = sumMatching(after, 'cache_lookups_total');
  const cacheAbsHits = sumMatching(after, 'cache_lookups_total', (l) => l.outcome === 'hit');
  // `outcome=allow|throttle|fallback`. `fallback` means the limiter ran its JS bucket
  // because Redis would not answer — a *different* enforcement path, so a run that
  // silently measured the fallback says nothing about the Lua bucket in production,
  // and the report has to say which one it was.
  const throttleAllow = counterDelta('ratelimit_decisions_total', (l) => l.outcome === 'allow');
  const throttleDenied = counterDelta('ratelimit_decisions_total', (l) => l.outcome === 'throttle');
  const limiterFallback = counterDelta(
    'ratelimit_decisions_total',
    (l) => l.outcome === 'fallback',
  );
  // Both drivers must answer the same question with the same number: BullMQ
  // reports queue depth from its own gauges, the outbox driver from the ledger
  // view (the API does the same substitution, see metrics/collector.ts).
  const backend = backendOf(after);
  const queuePending =
    sumMatching(after, 'queue_jobs', (l) =>
      ['waiting', 'delayed', 'active'].includes(l.state ?? ''),
    ) || sumMatching(after, 'outbox_pending_messages');
  const serverP95 =
    bucketPercentile(deltaHist(before, after), 'http_request_duration_seconds', 0.95) ?? 0;
  const serverP99 =
    bucketPercentile(deltaHist(before, after), 'http_request_duration_seconds', 0.99) ?? 0;

  // Backlog drainage is the other half of "the queue is bounded": a run that ends
  // with thousands of jobs pending and no drain measurement is an unproven claim.
  let queueDrainSec = 0;
  if (queuePending > 0) {
    const drainStart = Date.now();
    const drainCapSec = Number(cfg.drainTimeoutSec ?? 20);
    while ((Date.now() - drainStart) / 1000 < drainCapSec) {
      await new Promise((r) => setTimeout(r, 2_000));
      const s = parsePrometheus((await probe(metricsUrl)).text);
      const pending =
        sumMatching(s, 'queue_jobs', (l) =>
          ['waiting', 'delayed', 'active'].includes(l.state ?? ''),
        ) || sumMatching(s, 'outbox_pending_messages');
      if (pending === 0) break;
    }
    queueDrainSec = round((Date.now() - drainStart) / 1000, 1);
  }

  const report = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    baseUrl,
    durationSec: round(elapsedSec, 2),
    vus: Number(cfg.vus ?? 10),
    tenants: tenants.map((t) => ({
      label: t.label,
      plan: t.plan,
      seededProjects: t.projects?.length ?? 0,
      ...perTenant.get(t.label).summary(),
      // Throughput per workspace is the isolation number: containment shows up as
      // "the attacker's rps plateaued", never as "the victims got slower".
      rps: round((perTenant.get(t.label).count ?? 0) / elapsedSec, 1),
    })),
    scenarios: [...perScenario.entries()].map(([name, s]) => ({ name, ...s.summary() })),
    totals: {
      requests: [...perTenant.values()].reduce((a, b) => a + b.count, 0),
      rps: round([...perTenant.values()].reduce((a, b) => a + b.count, 0) / elapsedSec, 1),
      error5xx: [...perTenant.values()].reduce((a, b) => a + b.errors, 0),
      p95Ms: round(percentileOfAll(perTenant, 0.95)),
      p99Ms: round(percentileOfAll(perTenant, 0.99)),
    },
    server: {
      // Both views, side by side, on purpose: `p95Ms` above is what a caller felt,
      // this is what the handler reported. The difference is queueing — sockets,
      // the event loop, admission control — and it is the number that tells you
      // whether a slow tail is the database or the process in front of it.
      p95Ms: round(serverP95 * 1000),
      p99Ms: round(serverP99 * 1000),
      cacheLookups: cacheTotalInc,
      cacheHitRatio: cacheTotalInc ? round(cacheHitInc / cacheTotalInc, 4) : null,
      cacheAbsoluteHitRatio: cacheAbsTotal ? round(cacheAbsHits / cacheAbsTotal, 4) : null,
      rateLimitAllowed: throttleAllow,
      rateLimitThrottled: throttleDenied,
      throttlePct:
        throttleAllow + throttleDenied
          ? round((100 * throttleDenied) / (throttleAllow + throttleDenied), 2)
          : 0,
      queuePending,
      limiterFallback,
      backend,

      queueDrainSec,
      dbPool: [...after.entries()]
        .filter(([k]) => k.startsWith('pg_pool_connections'))
        .map(([k, v]) => `${k.split('|')[1] || 'total'}=${v}`),
    },
  };

  const failures = evaluateThresholds(cfg.thresholds ?? [], report);
  printReport(report, failures, cfg);

  if (args.out) await writeFile(args.out, JSON.stringify(report, null, 2));
  if (args.emitK6) await writeFile(args.emitK6, toK6Script(cfg));
  if (failures.length) process.exitCode = 1;
}

/**
 * Cumulative histogram → deltas per bucket. Subtracting two Prometheus snapshots
 * turns "since boot" into "since the run started", which is the only version of
 * the number that belongs to this run.
 */
function deltaHist(before, after) {
  const out = new Map();
  for (const [key, value] of after) {
    if (!key.startsWith('http_request_duration_seconds_bucket')) continue;
    out.set(key, value - (before.get(key) ?? 0));
  }
  return out;
}

function percentileOfAll(perTenant, q) {
  const all = [];
  for (const s of perTenant.values()) all.push(...s.latency);
  if (!all.length) return 0;
  const sorted = Float64Array.from(all).sort();
  return Number(sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))]);
}

function evaluateThresholds(thresholds, report) {
  const failures = [];
  for (const t of thresholds) {
    const value = resolve(t.metric, report);
    if (value === undefined || value === null) {
      failures.push(`${t.metric}: no such metric (check the config)`);
      continue;
    }
    if (t.max !== undefined && value > t.max) failures.push(`${t.metric}=${value} > max ${t.max}`);
    if (t.min !== undefined && value < t.min) failures.push(`${t.metric}=${value} < min ${t.min}`);
  }
  return failures;
}

/** `tenants[0].p99Ms`, `server.cacheHitRatio`, `worstVictim.p95Ms` (see below). */
function resolve(path, report) {
  if (path.startsWith('worstVictim.')) {
    const key = path.split('.')[1];
    // Victim selection is by plan *or* by label, because load-generated workspace
    // names are unique per run and cannot be hard-coded in a committed config.
    const wanted = new Set([...(cfg.victims ?? []), ...(cfg.victimPlans ?? [])]);
    const pool = report.tenants.filter(
      (t) => wanted.size === 0 || wanted.has(t.label) || wanted.has(t.plan),
    );
    if (!pool.length) return undefined;
    return Math.max(...pool.map((t) => t[key] ?? 0));
  }
  return path.split('.').reduce((acc, part) => {
    if (acc === undefined || acc === null) return undefined;
    const idx = /^\[(\d+)\]$/.exec(part);
    if (idx) return acc[Number(idx[1])];
    return acc[part];
  }, report);
}

function printReport(report, failures, cfg) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\nload run against ${report.baseUrl}  (${report.durationSec}s, ${report.vus} VUs)`);
  console.log(
    pad('tenant', 22) +
      pad('plan', 12) +
      pad('req', 8) +
      pad('p50', 8) +
      pad('p95', 9) +
      pad('p99', 9) +
      pad('max', 9) +
      pad('429 (pct)', 14) +
      pad('rps', 7) +
      '5xx',
  );
  for (const t of report.tenants) {
    console.log(
      pad(t.label, 22) +
        pad(t.plan, 12) +
        pad(t.requests, 8) +
        pad(t.p50Ms, 8) +
        pad(t.p95Ms, 9) +
        pad(t.p99Ms, 9) +
        pad(t.maxMs, 9) +
        pad(`${t.throttled} (${round((t.throttleRate ?? 0) * 100)}%)`, 14) +
        pad(t.rps, 7) +
        t.error5xx,
    );
  }
  console.log('\nscenario');
  for (const s of report.scenarios) {
    console.log(
      pad(s.name, 26) +
        pad(s.requests, 8) +
        pad(`p95=${s.p95Ms}`, 12) +
        pad(`p99=${s.p99Ms}`, 12) +
        `429=${s.throttled} 5xx=${s.error5xx}`,
    );
  }
  console.log('\nserver (from /metrics, this run only)');
  const sv = report.server;
  console.log(
    `  p95=${sv.p95Ms}ms p99=${sv.p99Ms}ms  cache hit=${sv.cacheAbsoluteHitRatio ?? 'n/a'} (${sv.cacheLookups} lookups)  ` +
      `throttled=${sv.rateLimitThrottled}/${sv.rateLimitAllowed + sv.rateLimitThrottled} (${sv.throttlePct}%)  queue pending=${sv.queuePending}` +
      (sv.queueDrainSec ? ` drained in ${sv.queueDrainSec}s` : '') +
      (sv.limiterFallback ? ` limiter-fallback=${sv.limiterFallback}` : ''),
  );
  if (sv.backend && sv.backend.cache === 'memory') {
    console.log(
      `  WARNING: cache/limiter backend is ${sv.backend.cache} (driver=${sv.backend.queue_driver}) — ` +
        'no Redis in this run. The bucket arithmetic and the request path are real, the ' +
        'Redis round-trip is not: read these numbers as single-pod.',
    );
  }
  if (sv.limiterFallback) {
    console.log('  WARNING: some decisions came from the JS fallback limiter, not the Lua bucket.');
  }
  if (report.totals)
    console.log(
      `  totals: ${report.totals.requests} requests, ${report.totals.rps} req/s, ${report.totals.error5xx} 5xx`,
    );
  if (failures.length) {
    console.log('\nTHRESHOLDS FAILED');
    for (const f of failures) console.log(`  ✗ ${f}`);
  } else if ((cfg.thresholds ?? []).length) {
    console.log(`\nall ${cfg.thresholds.length} thresholds held`);
  }
}

function toK6Script(config) {
  // Same config, k6 runtime: scenarios, weights and thresholds translate 1:1, so
  // `k6 run` and this tool describe the same experiment.
  return `// Generated by tools/loadgen/loadgen.mjs --emit-k6. Do not edit by hand.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || ${JSON.stringify(config.baseUrl ?? 'http://127.0.0.1:3000')};
const SCENARIOS = ${JSON.stringify(config.scenarios ?? [], null, 2)};

export const options = {
  vus: ${config.vus ?? 10},
  duration: ${JSON.stringify(String(config.duration ?? '30s'))},
  thresholds: ${JSON.stringify(
    Object.fromEntries(
      (config.thresholds ?? [])
        .filter((t) => typeof t.metric === 'string' && !t.metric.includes('tenants['))
        .map((t) => [
          t.metric,
          [
            `${t.max !== undefined ? `max=${t.max}` : ''}${t.min !== undefined ? ` min=${t.min}` : ''}`.trim(),
          ],
        ]),
    ),
  )},
};

export default function () {
  const s = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
  const res = http.request(s.method || 'GET', BASE + s.path, s.body ? JSON.stringify(s.body) : null, {
    headers: { 'content-type': 'application/json' },
  });
  check(res, { 'not 5xx': (r) => r.status < 500 });
  if (s.thinkMs) sleep(s.thinkMs / 1000);
}
`;
}

// ------------------------------------------------------------------ utils ----

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--config') out.config = argv[++i];
    else if (a === '--base-url') out.baseUrl = argv[++i];
    else if (a === '--metrics-url') out.metricsUrl = argv[++i];
    else if (a === '--duration') out.duration = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--emit-k6') out.emitK6 = argv[++i];
    else throw new Error(`unknown argument ${a}\n\n${usage()}`);
  }
  return out;
}

function parseDuration(v) {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/.exec(String(v).trim());
  if (!m) throw new Error(`bad duration ${v}`);
  const mult = m[2] === 'ms' ? 1 : m[2] === 'm' ? 60_000 : 1000;
  return Number(m[1]) * mult;
}

function usage() {
  return `loadgen — dependency-free load generator for the multi-tenant API

  node tools/loadgen/loadgen.mjs --config loadtests/load.config.json
       [--base-url URL] [--metrics-url URL] [--duration 30s]
       [--out results.json] [--emit-k6 loadtests/generated.js]

Config keys: baseUrl, metricsUrl, vus, duration, rampUp, thinkMs, slugPrefix,
seedProjects, tenants[{count,plan|useSeed,user,password}], victims[labels],
scenarios[{name,method,path,body,weight,thinkMs,rpsPerVu,idempotency,headers}],
scenariosByPlan (optional per-plan override of \`scenarios\`),
thresholds[{metric,max|min}].

Threshold metrics are dotted paths into the report: totals.p99Ms,
server.cacheHitRatio, server.throttlePct, worstVictim.p95Ms (uses \`victims\`).`;
}

await run().catch((err) => {
  console.error(`loadgen failed: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof HttpError)
    console.error(`  status ${err.status}: ${String(err.body).slice(0, 300)}`);
  console.error('  is the API up? BASE_URL must point at a running `npm run dev:api`.');
  process.exit(2);
});
