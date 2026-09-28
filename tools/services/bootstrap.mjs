#!/usr/bin/env node
/**
 * Local service bootstrap for machines without Docker.
 *
 *   node tools/services/bootstrap.mjs pg-init            # one-time cluster init
 *   node tools/services/bootstrap.mjs pg-run &           # foreground server
 *   node tools/services/bootstrap.mjs pg-status          # what is listening?
 *   node tools/services/bootstrap.mjs pg-stop
 *   node tools/services/bootstrap.mjs pg-url             # DATABASE_URL
 *
 * It runs a *real* PostgreSQL (the `embedded-postgres` npm package ships the
 * server binary) with its data directory under .tmp-services/, so `make dev`
 * works on a locked-down laptop, in CI sandboxes, and anywhere Docker is not
 * available. RLS, advisory locks and `FOR UPDATE SKIP LOCKED` are genuinely
 * exercised — an emulator would have hidden the exact bugs this repo is about.
 *
 * Redis is NOT emulated here: use `REDIS_*_URL=memory://` for the in-process
 * double (see packages/shared/src/kv/memoryKv.ts), or `make compose-up` for the
 * real thing. `pg-status` reports which mode you are in.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const stateDir = resolve(repoRoot, '.tmp-services');
const stateFile = resolve(stateDir, 'pg.json');
const dataDir = resolve(stateDir, 'pgdata');

const USER = 'postgres';
const PASSWORD = 'postgres';

const args = parseArgs(process.argv.slice(2));
const port = Number(args.port ?? process.env.SAAS_PG_PORT ?? 55432);
const database = String(args.db ?? process.env.SAAS_PG_DB ?? 'saas');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const url = (p = port, db = database) => `postgres://${USER}:${PASSWORD}@127.0.0.1:${p}/${db}`;
const adminUrl = (p = port) => `postgres://${USER}:${PASSWORD}@127.0.0.1:${p}/postgres`;

function makePg() {
  return new EmbeddedPostgres({
    user: USER,
    password: PASSWORD,
    port,
    databaseDir: dataDir,
    persistent: true,
    // Laptop-sized, but a real config: WAL and fsync stay on so lock and
    // visibility semantics match production.
    postgresFlags: [
      '-c',
      'shared_buffers=128MB',
      '-c',
      'max_connections=200',
      '-c',
      'synchronous_commit=off',
      '-c',
      'listen_addresses=127.0.0.1',
      '-c',
      'log_min_duration_statement=250',
      '-c',
      'timezone=UTC',
    ],
    onLog: () => undefined,
    onError: (m) => process.stderr.write(`[postgres] ${m}\n`),
  });
}

function nativeBin(name) {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('@embedded-postgres/linux-x64/package.json');
  return resolve(dirname(pkg), 'native/bin', name);
}

async function init() {
  // initialise() + start + createDatabase + stop: everything a first `make dev`
  // needs before the long-lived `pg-run` takes over.
  mkdirSync(stateDir, { recursive: true });
  if (args.reset) {
    rmSync(dataDir, { recursive: true, force: true });
  }
  const pg = makePg();
  if (!existsSync(resolve(dataDir, 'PG_VERSION'))) {
    process.stdout.write('initialising postgres cluster (one-time)...\n');
    await pg.initialise();
    await pg.start();
    try {
      const client = pg.getPgClient('postgres');
      await client.connect();
      const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
        database,
      ]);
      if (!rows.length) {
        await client.query(`CREATE DATABASE "${database.replace(/"/g, '')}"`);
        process.stdout.write(`created database ${database}\n`);
      }
      await client.end();
    } finally {
      await pg.stop();
    }
  } else {
    process.stdout.write(`cluster already initialised at ${dataDir}\n`);
  }
  writeFileSync(
    stateFile,
    JSON.stringify({ port, dataDir, database, initialisedAt: new Date().toISOString() }, null, 2),
  );
  process.stdout.write('ok\n');
}

async function run() {
  mkdirSync(stateDir, { recursive: true });
  if (!existsSync(resolve(dataDir, 'PG_VERSION'))) {
    const fresh = makePg();
    await fresh.initialise();
  }
  const pg = makePg();
  await pg.start();
  writeFileSync(
    stateFile,
    JSON.stringify(
      { port, dataDir, database, pid: process.pid, startedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  process.stdout.write(`postgres listening on 127.0.0.1:${port} (db=${database})\n`);
  process.stdout.write(`DATABASE_URL=${url()}\n`);

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) {
      return;
    }
    stopping = true;
    process.stdout.write(`\nreceived ${signal}, stopping postgres\n`);
    try {
      await pg.stop();
    } catch (err) {
      process.stderr.write(`stop failed (${err.message}); falling back to pg_ctl\n`);
      spawnSync(nativeBin('pg_ctl'), ['-D', dataDir, '-m', 'fast', 'stop'], { stdio: 'inherit' });
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  // Stay alive; postgres is a child of this process.
  setInterval(() => undefined, 1 << 30);
}

async function stopCmd() {
  // Prefer telling the `pg-run` wrapper to exit: it owns the child process and
  // shuts Postgres down cleanly (fast mode). Then fall back to pg_ctl.
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
  if (state?.pid) {
    try {
      process.kill(state.pid, 'SIGTERM');
      await new Promise((r) => setTimeout(r, 1500));
    } catch {
      /* already gone */
    }
  }
  const res = spawnSync(nativeBin('pg_ctl'), ['-D', dataDir, '-m', 'fast', 'stop'], {
    encoding: 'utf8',
  });
  if (res.status === 0) {
    process.stdout.write('postgres stopped\n');
  } else {
    process.stdout.write(`postgres was not running (or already stopped)\n${res.stderr ?? ''}`);
  }
  rmSync(stateFile, { force: true });
}

async function canConnect() {
  try {
    const { default: pgMod } = await import('pg');
    const client = new pgMod.Client({
      connectionString: adminUrl(),
      connectionTimeoutMillis: 1500,
    });
    await client.connect();
    const r = await client.query('SHOW server_version');
    await client.end();
    return r.rows[0].server_version;
  } catch {
    return null;
  }
}

async function status() {
  const version = await canConnect();
  const redisHint = process.env.REDIS_CACHE_URL ?? 'memory:// (in-process double)';
  process.stdout.write(
    JSON.stringify(
      {
        postgres: version
          ? { status: 'up', version, url: url(), dataDir }
          : { status: 'down', hint: 'node tools/services/bootstrap.mjs pg-run &', dataDir },
        redisCache: redisHint,
        redisQueue: process.env.REDIS_QUEUE_URL ?? redisHint,
        next: version ? 'npm run db:migrate && npm run db:seed' : 'start postgres first',
      },
      null,
      2,
    ) + '\n',
  );
  process.exit(version ? 0 : 1);
}

switch (args._[0] ?? 'help') {
  case 'pg-init':
    await init();
    break;
  case 'pg-run':
    await run();
    break;
  case 'pg-stop':
    await stopCmd();
    break;
  case 'pg-status':
  case 'status':
    await status();
    break;
  case 'pg-url':
    process.stdout.write(url() + '\n');
    break;
  case 'admin-url':
    process.stdout.write(adminUrl() + '\n');
    break;
  default:
    process.stdout.write(
      'usage: bootstrap.mjs <pg-init|pg-run|pg-stop|pg-status|pg-url|admin-url> [--port N] [--db name] [--reset]\n',
    );
    process.exit(0);
}
