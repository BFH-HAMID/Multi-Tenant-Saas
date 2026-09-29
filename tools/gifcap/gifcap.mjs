#!/usr/bin/env node
// tools/gifcap — turn a live /metrics stream into an animated GIF.
//
// Why this exists: a README can *claim* "victims stayed fast while one tenant
// flooded the API", but a recording of the actual /metrics endpoint during the
// actual load run is evidence. Every number in the GIF below is sampled from
// the running API/worker, one frame per second; playback speed is the only
// presentation choice (1s of run = 100ms of GIF by default, and the footer
// says so).
//
// Usage (see `make capture-gif` for the one-liner that pairs it with a load):
//   node tools/gifcap/gifcap.mjs \
//     --api-metrics http://127.0.0.1:9464/metrics \
//     --worker-metrics http://127.0.0.1:9465/metrics \
//     --out docs/assets/isolation-capture.gif \
//     --duration-ms 62000 --title "MULTI-TENANT SAAS - ISOLATION RUN"
//
// No native dependencies: rendering is a hand-rolled 5x7 bitmap font onto an
// indexed-color buffer, and omggif (pure JS) writes the LZW-GIF.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { GifWriter } from 'omggif';

// ---------------------------------------------------------------- arguments

const args = argmap(process.argv.slice(2));
const API_METRICS = args['api-metrics'] ?? 'http://127.0.0.1:9464/metrics';
const WORKER_METRICS = args['worker-metrics'] ?? null;
const OUT = args.out ?? 'capture.gif';
const INTERVAL_MS = number(args['interval-ms'] ?? 1000, 1_000);
const DURATION_MS = number(args['duration-ms'] ?? 60_000, 1_000);
const TITLE = (args.title ?? 'LIVE METRICS CAPTURE').toUpperCase().slice(0, 48);
const PLAY_DELAY_CS = Math.max(2, Math.round(number(args['play-ms-per-sample'] ?? 100, 100) / 10));
const W = 640;
const H = 360;

function argmap(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}
function number(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ------------------------------------------------------------------ palette

const PALETTE = [
  0x0b1220, // 0 background
  0x111a2e, // 1 panel
  0x23324d, // 2 grid / border
  0xe8edf5, // 3 text
  0x7e8aa3, // 4 dim text
  0x34d399, // 5 green (victims / p95 / healthy)
  0xfbbf24, // 6 amber (throttled)
  0xf87171, // 7 red (attacker)
  0x60a5fa, // 8 blue (totals)
  0xa78bfa, // 9 purple (worker)
  0x3a2f10, // 10 dark amber fill
  0x0b1220, // 11..15 unused — GIF palettes must be a power of two
  0x0b1220,
  0x0b1220,
  0x0b1220,
  0x0b1220,
];
const BG = 0,
  PANEL = 1,
  GRID = 2,
  TEXT = 3,
  DIM = 4,
  GREEN = 5,
  AMBER = 6,
  RED = 7,
  BLUE = 8,
  PURPLE = 9,
  AMBER_DARK = 10;

// --------------------------------------------------- 5x7 bitmap font (hex)

const FONT = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x13, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  3: [0x0e, 0x11, 0x01, 0x06, 0x01, 0x11, 0x0e],
  4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 0x0c, 0x0c],
  ':': [0, 0x0c, 0x0c, 0, 0x0c, 0x0c, 0],
  '-': [0, 0, 0, 0x1f, 0, 0, 0],
  '/': [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10],
  '%': [0x19, 0x1a, 0x02, 0x04, 0x08, 0x0b, 0x13],
  '+': [0, 0x04, 0x04, 0x1f, 0x04, 0x04, 0],
  '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  '!': [0x04, 0x04, 0x04, 0x04, 0x04, 0, 0x04],
};

// ------------------------------------------------------------- raster ops

class Raster {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h);
  }
  set(x, y, c) {
    x = Math.round(x);
    y = Math.round(y);
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.px[y * this.w + x] = c;
  }
  rect(x, y, w, h, c) {
    for (let i = 0; i < w; i += 1) {
      this.set(x + i, y, c);
      this.set(x + i, y + h - 1, c);
    }
    for (let j = 0; j < h; j += 1) {
      this.set(x, y + j, c);
      this.set(x + w - 1, y + j, c);
    }
  }
  fillRect(x, y, w, h, c) {
    for (let j = 0; j < h; j += 1) for (let i = 0; i < w; i += 1) this.set(x + i, y + j, c);
  }
  hline(x, y, w, c) {
    for (let i = 0; i < w; i += 1) this.set(x + i, y, c);
  }
  line(x0, y0, x1, y1, c) {
    // Bresenham; called with chart coordinates already clipped to the panel.
    let x = Math.round(x0);
    let y = Math.round(y0);
    const xEnd = Math.round(x1);
    const yEnd = Math.round(y1);
    const dx = Math.abs(xEnd - x);
    const dy = Math.abs(yEnd - y);
    const sx = x < xEnd ? 1 : -1;
    const sy = y < yEnd ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      this.set(x, y, c);
      this.set(x, y + 1, c); // 2px thickness so the line survives scaling
      if (x === xEnd && y === yEnd) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
    }
  }
  text(str, x, y, c, scale = 1) {
    let cx = x;
    for (const chRaw of String(str).toUpperCase()) {
      const glyph = FONT[chRaw] ?? FONT[' '];
      for (let row = 0; row < 7; row += 1) {
        const bits = glyph[row];
        for (let col = 0; col < 5; col += 1) {
          if (bits & (1 << (4 - col))) {
            this.fillRect(cx + col * scale, y + row * scale, scale, scale, c);
          }
        }
      }
      cx += 6 * scale;
    }
    return cx;
  }
  textWidth(str, scale = 1) {
    return String(str).length * 6 * scale - scale;
  }
}

// ------------------------------------------------------------ prom parsing

function parseSeries(body) {
  const out = [];
  for (const line of body.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([^\s{]+)(?:\{([^}]*)\})?\s+([^\s]+)$/);
    if (!m) continue;
    const value = Number(m[3]);
    if (!Number.isFinite(value)) continue;
    const labels = {};
    if (m[2]) {
      for (const lm of m[2].matchAll(/([a-zA-Z_]+)="((?:[^"\\]|\\.)*)"/g)) labels[lm[1]] = lm[2];
    }
    out.push({ name: m[1], labels, value });
  }
  return out;
}

function sum(series, name, pred) {
  let total = 0;
  let seen = false;
  for (const s of series) {
    if (s.name !== name) continue;
    if (pred && !pred(s.labels)) continue;
    total += s.value;
    seen = true;
  }
  return seen ? total : null;
}

/** One point-in-time snapshot of everything the GIF needs. */
async function sample() {
  const snap = {
    t: Date.now(),
    total: 0,
    buckets: new Map(),
    allow: 0,
    throttle: 0,
    cacheHit: 0,
    cacheMiss: 0,
    outboxPending: 0,
    reportsDone: 0,
    tenants: new Map(),
  };
  const apiSeries = parseSeries(await fetchText(API_METRICS));
  for (const s of apiSeries) {
    if (s.name === 'http_request_duration_seconds_count') snap.total += s.value;
    if (s.name === 'http_request_duration_seconds_bucket') {
      const le = s.labels.le;
      snap.buckets.set(le, (snap.buckets.get(le) ?? 0) + s.value);
    }
    if (s.name === 'ratelimit_decisions_total' && s.labels.outcome === 'allow')
      snap.allow += s.value;
    if (s.name === 'ratelimit_decisions_total' && s.labels.outcome === 'throttle')
      snap.throttle += s.value;
    if (
      s.name === 'cache_lookups_total' &&
      (s.labels.outcome === 'hit' || s.labels.outcome === 'coalesced')
    )
      snap.cacheHit += s.value;
    if (s.name === 'cache_lookups_total' && s.labels.outcome === 'miss') snap.cacheMiss += s.value;
    if (s.name === 'outbox_pending_messages') snap.outboxPending += s.value;
    if (s.name === 'tenant_requests_total') {
      const t = s.labels.tenant ?? '?';
      snap.tenants.set(t, (snap.tenants.get(t) ?? 0) + s.value);
    }
  }
  if (WORKER_METRICS) {
    const workerSeries = parseSeries(await fetchText(WORKER_METRICS));
    snap.reportsDone =
      sum(
        workerSeries,
        'queue_job_results_total',
        (l) => l.queue === 'reports' && l.outcome === 'completed',
      ) ?? 0;
  }
  return snap;
}

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(4_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

// ------------------------------------------------------------ derivation

function derive(samples) {
  const dt = INTERVAL_MS / 1000;
  const rows = [];
  let prev = null;
  for (const s of samples) {
    if (!prev) {
      rows.push({ rps: 0, p95: 0, throttlePct: 0, cachePct: 0, attacker: 0, victims: 0 });
      prev = s;
      continue;
    }
    const rps = Math.max(0, (s.total - prev.total) / dt);
    const dA = Math.max(0, s.allow - prev.allow);
    const dT = Math.max(0, s.throttle - prev.throttle);
    const dHit = Math.max(0, s.cacheHit - prev.cacheHit);
    const dMiss = Math.max(0, s.cacheMiss - prev.cacheMiss);
    // p95 from the *delta* of cumulative histogram buckets: the run's own
    // latency distribution, not a running average since process start.
    const deltas = [...s.buckets.entries()].map(([le, v]) => {
      const before = prev.buckets.get(le) ?? v;
      return [le, Math.max(0, v - before)];
    });
    const total = deltas.find(([le]) => le === '+Inf')?.[1] ?? 0;
    let p95 = 0;
    if (total > 0) {
      let cum = 0;
      for (const [le, d] of deltas) {
        cum += d;
        if (cum >= 0.95 * total) {
          p95 = le === '+Inf' ? 10_000 : Number(le) * 1000;
          break;
        }
      }
    }
    rows.push({
      rps,
      p95,
      throttlePct: dA + dT > 0 ? (dT / (dA + dT)) * 100 : 0,
      cachePct: dHit + dMiss > 0 ? (dHit / (dHit + dMiss)) * 100 : 0,
      attacker: 0,
      victims: 0,
    });
    prev = s;
  }
  attachTenantRoles(samples, rows, dt);
  return { rows, roles: lastRoles };
}

let lastRoles = { attacker: null, victims: [] };

/**
 * "Attacker" = the tenant that grew the most during the capture; "victims" =
 * the next four. Growth is measured from each tenant's *first observed*
 * sample, not the capture's first sample — load generators create their
 * tenants a few seconds in, and basing them on sample 0 (where they are
 * absent) silently scores all of their traffic as zero. Classifying once (not
 * per frame) keeps a line from changing identity mid-plot when two tenants
 * briefly swap rank.
 */
function attachTenantRoles(samples, rows, dt) {
  const firstSeen = new Map();
  const last = new Map();
  for (const s of samples) {
    for (const [tenant, v] of s.tenants) {
      if (!firstSeen.has(tenant)) firstSeen.set(tenant, v);
      last.set(tenant, v);
    }
  }
  const ranked = [...last.entries()]
    .map(([tenant, v]) => [tenant, v - (firstSeen.get(tenant) ?? v)])
    .sort((a, b) => b[1] - a[1]);
  const attacker = ranked[0]?.[0] ?? null;
  const victims = ranked.slice(1, 5).map(([t]) => t);
  lastRoles = { attacker, victims };
  samples.forEach((s, i) => {
    if (i === 0) return;
    const prev = samples[i - 1];
    const d = (t) => Math.max(0, (s.tenants.get(t) ?? 0) - (prev.tenants.get(t) ?? 0)) / dt;
    rows[i].attacker = attacker ? d(attacker) : 0;
    rows[i].victims = victims.length
      ? victims.reduce((acc, t) => acc + d(t), 0) / victims.length
      : 0;
  });
}

// ---------------------------------------------------------------- layout

const MAIN = { x: 14, y: 44, w: 396, h: 230 };
const P95 = { x: 422, y: 44, w: 204, h: 110 };
const THR = { x: 422, y: 162, w: 204, h: 112 };
const STATS_Y = 284;
const STATS_H = 48;

function niceMax(v, step) {
  return Math.max(step, Math.ceil(v / step) * step);
}

function chartGeom(panel, points, padTop = 6) {
  const cx = panel.x + 8;
  const cy = panel.y + padTop;
  const cw = panel.w - 16;
  const ch = panel.h - padTop - 10;
  const stepX = points > 1 ? cw / (points - 1) : 0;
  return { cx, cy, cw, ch, stepX };
}

function drawGrid(r, geom, yMax, unit = '') {
  r.rect(geom.cx - 1, geom.cy - 1, geom.cw + 2, geom.ch + 2, GRID);
  for (const frac of [0, 0.5, 1]) {
    const y = geom.cy + geom.ch - Math.round(geom.ch * frac);
    r.hline(geom.cx, y, geom.cw, GRID);
    r.text(`${Math.round(yMax * frac)}${unit}`, geom.cx + 2, y - 9, DIM);
  }
}

function drawSeries(r, geom, values, upto, color, yMax) {
  for (let i = 1; i <= upto; i += 1) {
    const x0 = geom.cx + (i - 1) * geom.stepX;
    const x1 = geom.cx + i * geom.stepX;
    const y0 = geom.cy + geom.ch - (values[i - 1] / yMax) * geom.ch;
    const y1 = geom.cy + geom.ch - (values[i] / yMax) * geom.ch;
    r.line(x0, y0, x1, y1, color);
  }
}

function statBox(r, x, label, value, color) {
  r.rect(x, STATS_Y, 150, STATS_H, GRID);
  r.text(label, x + 8, STATS_Y + 6, DIM);
  r.text(value, x + 8, STATS_Y + 22, color, 2);
}

// -------------------------------------------------------------- rendering

function render(rows, samples, expected) {
  const maxRps = niceMax(Math.max(...rows.map((x) => x.rps), 1), 200);
  const maxP95 = niceMax(Math.max(...rows.map((x) => x.p95), 1), 10);
  const totalReq = samples.at(-1)?.total ?? 0;
  const frames = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const r = new Raster(W, H);
    r.fillRect(0, 0, W, H, BG);

    // header
    r.text(TITLE, 14, 10, TEXT, 2);
    const clock = `T+${String(Math.round((i * INTERVAL_MS) / 1000))}S`;
    r.text(clock, W - 14 - r.textWidth(clock, 2), 10, BLUE, 2);
    r.hline(14, 34, W - 28, GRID);

    // main chart: attacker vs victims (the noisy-neighbour picture)
    r.rect(MAIN.x, MAIN.y, MAIN.w, MAIN.h, GRID);
    r.fillRect(MAIN.x + 1, MAIN.y + 1, MAIN.w - 2, MAIN.h - 2, PANEL);
    r.text('REQ/S BY TENANT ROLE', MAIN.x + 8, MAIN.y + 6, DIM);
    r.fillRect(MAIN.x + 8, MAIN.y + 21, 8, 8, RED);
    r.text(`ATTACKER ${Math.round(row.attacker)}/S`, MAIN.x + 20, MAIN.y + 19, RED);
    r.fillRect(MAIN.x + 190, MAIN.y + 21, 8, 8, GREEN);
    r.text(`VICTIMS AVG ${row.victims.toFixed(1)}/S`, MAIN.x + 202, MAIN.y + 19, GREEN);
    const geom = chartGeom(MAIN, expected, 36);
    drawGrid(r, geom, maxRps);
    drawSeries(
      r,
      geom,
      rows.map((x) => x.attacker),
      i,
      RED,
      maxRps,
    );
    drawSeries(
      r,
      geom,
      rows.map((x) => x.victims),
      i,
      GREEN,
      maxRps,
    );

    // p95 panel
    r.rect(P95.x, P95.y, P95.w, P95.h, GRID);
    r.fillRect(P95.x + 1, P95.y + 1, P95.w - 2, P95.h - 2, PANEL);
    r.text('P95 LATENCY (MS)', P95.x + 8, P95.y + 6, DIM);
    r.text(
      row.p95 >= 10000 ? 'MAX' : row.p95.toFixed(0),
      P95.x + P95.w - 8 - r.textWidth(row.p95 >= 10000 ? 'MAX' : row.p95.toFixed(0), 2),
      P95.y + 6,
      GREEN,
      2,
    );
    const g95 = chartGeom(P95, expected, 24);
    drawGrid(r, g95, maxP95);
    drawSeries(
      r,
      g95,
      rows.map((x) => x.p95),
      i,
      GREEN,
      maxP95,
    );

    // throttled panel (filled area: this is "the limiter working", so amber)
    r.rect(THR.x, THR.y, THR.w, THR.h, GRID);
    r.fillRect(THR.x + 1, THR.y + 1, THR.w - 2, THR.h - 2, PANEL);
    r.text('THROTTLED %', THR.x + 8, THR.y + 6, DIM);
    r.text(
      `${row.throttlePct.toFixed(0)}%`,
      THR.x + THR.w - 8 - r.textWidth(`${row.throttlePct.toFixed(0)}%`, 2),
      THR.y + 6,
      AMBER,
      2,
    );
    const gThr = chartGeom(THR, expected, 24);
    drawGrid(r, gThr, 100);
    for (let k = 1; k <= i; k += 1) {
      const x = gThr.cx + k * gThr.stepX;
      const yv = gThr.cy + gThr.ch - (rows[k].throttlePct / 100) * gThr.ch;
      for (let y = yv; y < gThr.cy + gThr.ch; y += 2) r.set(x, y, AMBER_DARK);
    }
    drawSeries(
      r,
      gThr,
      rows.map((x) => x.throttlePct),
      i,
      AMBER,
      100,
    );

    // stat boxes
    statBox(r, 14, 'TOTAL REQUESTS', String(Math.round(totalReq)), BLUE);
    statBox(r, 172, 'CACHE HIT %', `${row.cachePct.toFixed(1)}%`, GREEN);
    statBox(r, 330, 'REPORTS COMPLETED', String(samples[i]?.reportsDone ?? 0), PURPLE);
    statBox(r, 488, 'OUTBOX PENDING', String(samples[i]?.outboxPending ?? 0), GREEN);

    r.text('LIVE /METRICS CAPTURE - 1S SAMPLES - PLAYBACK AT 10X', 14, 344, DIM);
    frames.push(r.px);
  }
  return frames;
}

// ------------------------------------------------------------------- main

async function main() {
  const expected = Math.max(2, Math.round(DURATION_MS / INTERVAL_MS));
  const samples = [];
  const t0 = Date.now();
  process.stderr.write(
    `gifcap: sampling ${API_METRICS} every ${INTERVAL_MS}ms for ${DURATION_MS}ms…\n`,
  );
  while (Date.now() - t0 < DURATION_MS) {
    const s = await sample(); // a failed sample aborts the capture: a GIF with
    samples.push(s); // holes would be a lie, not a blip
    process.stderr.write(`gifcap: ${samples.length}/${expected} samples\r`);
    const nextAt = t0 + samples.length * INTERVAL_MS;
    const wait = nextAt - Date.now();
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
  }
  process.stderr.write('\n');

  const { rows, roles } = derive(samples);
  const maxA = Math.max(...rows.map((x) => x.attacker), 0);
  const maxV = Math.max(...rows.map((x) => x.victims), 0);
  process.stderr.write(
    'gifcap: attacker=' +
      (roles.attacker ?? 'none') +
      ' victims=[' +
      roles.victims.join(', ') +
      ']' +
      ' maxAttacker=' +
      maxA.toFixed(0) +
      '/s maxVictims=' +
      maxV.toFixed(1) +
      '/s\n',
  );
  const frames = render(rows, samples, expected);

  const buf = new Uint8Array(W * H * frames.length + 4096 * frames.length + 4096);
  const gf = new GifWriter(buf, W, H, { palette: PALETTE, loop: 0 });
  for (const frame of frames) gf.addFrame(0, 0, W, H, frame, { delay: PLAY_DELAY_CS });
  gf.end(); // trailer byte — without it most decoders show one long final frame
  const bytes = buf.subarray(0, gf.getOutputBufferPosition());
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, bytes);
  process.stderr.write(
    `gifcap: ${frames.length} frames → ${OUT} (${(bytes.length / 1024).toFixed(0)} KiB, ${frames.length}s of run at ${PLAY_DELAY_CS * 10}ms/frame)\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`gifcap: ${String(err)}\n`);
  process.exit(1);
});
