// Sector shard: the one stateful service. It holds a whole sector in memory,
// simulates it at 10 Hz, answers intents arriving over NATS, publishes what
// changed, and persists to Postgres:
//
//   - player intents (build, cargo, refit...) commit to Postgres *before* the
//     ack goes back, so anything a player was told succeeded survives a crash;
//   - everything the simulation does on its own (construction finishing,
//     health lines, squads marching, position reports) is written behind,
//     every SAVE_INTERVAL_MS. A crash loses at most that window of it.
//
// Exactly one process may own a sector at a time (two would fork the world).
// Compose runs one replica; on Kubernetes it becomes a StatefulSet with one
// replica per sector.
import { randomUUID } from 'node:crypto';
import { bus, Heartbeat, IntentRequest, JoinRequest, LeaveMessage, PosMessage, subj } from '@eden/kit/bus';
import { migrate, pool } from '@eden/kit/db';
import { env, envInt } from '@eden/kit/env';
import { onShutdown, probeServer } from '@eden/kit/lifecycle';
import { logger } from '@eden/kit/log';
import { decode, encode } from '@eden/shared/codec';
import type { Push } from '@eden/shared/protocol';
import { Sector } from '@eden/shared/sim/Sector';
import { runIntent } from './intents';
import { MIGRATIONS } from './migrations';
import { Saver, Store } from './store';

const SECTOR = envInt('SECTOR', 1);
const SEED = envInt('SEED', 20261029);
const RADIUS = envInt('RADIUS_PX', 14000);
const SAVE_INTERVAL_MS = envInt('SAVE_INTERVAL_MS', 2000);
/** A gateway that hasn't sent a heartbeat for this long is presumed dead; its players are logged out. */
const GATEWAY_TIMEOUT_MS = 30_000;

const log = logger('shard').child({ sector: SECTOR });
const db = pool(env('DATABASE_URL'), 'shard');
await migrate(db, 'shard', MIGRATIONS, log);
const nc = await bus(env('NATS_URL', 'nats://localhost:4222'), `shard-${SECTOR}`, log);

// ---------------------------------------------------------------- load
const store = new Store(db, SECTOR);
const t0 = performance.now();
const { epoch, data } = await store.load(SEED, RADIUS);
const publish = (subject: string, m: Push) => nc.publish(subject, encode(m));
const sector = new Sector(
  {
    seed: SEED,
    radiusPx: RADIUS,
    clock: () => Date.now() / 1000 - epoch,
    sink: {
      player: (e, m) => publish(subj.player(SECTOR, e), m),
      chunk: (ck, m) => publish(subj.chunk(SECTOR, ck), m),
      all: (m) => publish(subj.all(SECTOR), m),
    },
  },
  data,
);
log.info({ empires: sector.empireCount, ms: Math.round(performance.now() - t0), fresh: !data }, 'sector loaded');

let fatal = false;
const saver = new Saver(sector, store, log, () => {
  fatal = true;
  process.exit(1);
});
await saver.flush(); // record the restore's re-based health lines right away

// ---------------------------------------------------------------- sessions per gateway
/**
 * Which players each gateway holds. If a gateway dies it can't say goodbye for
 * its players, so we notice its heartbeats stopping and log them out ourselves.
 */
const gateways = new Map<string, { seen: number; sessions: Map<number, number> }>();
const gatewayOf = (id: string) => {
  let g = gateways.get(id);
  if (!g) gateways.set(id, (g = { seen: Date.now(), sessions: new Map() }));
  g.seen = Date.now();
  return g;
};

// ---------------------------------------------------------------- bus
const serve = <T>(subject: string, handle: (req: T) => Promise<unknown> | unknown) =>
  nc.subscribe(subject, {
    callback: (err, msg) => {
      if (err) return void log.error({ err, subject }, 'subscription error');
      void (async () => {
        try {
          const out = await handle(decode<T>(msg.data));
          if (msg.reply) msg.respond(encode(out ?? null));
        } catch (e) {
          log.error({ err: e, subject }, 'handler failed');
          if (msg.reply && !fatal) msg.respond(encode({ ok: false, reason: 'Server error' }));
        }
      })();
    },
  });

serve<IntentRequest>(subj.intent(SECTOR), async ({ empire, op, args }) => {
  const r = runIntent(sector, empire, op, args);
  // Write-through: the player hears "ok" only once it's durable.
  if (r.ok) await saver.flush();
  return r;
});

serve<JoinRequest>(subj.join(SECTOR), async ({ gateway, empire }) => {
  const g = gatewayOf(gateway);
  g.sessions.set(empire.id, (g.sessions.get(empire.id) ?? 0) + 1);
  const meta = sector.join(empire);
  await saver.flush(); // a brand-new empire is founded here: make it durable before they see it
  log.info({ empire: empire.id, gateway }, 'player joined');
  return meta;
});

serve<LeaveMessage>(subj.leave(SECTOR), ({ gateway, empire }) => {
  const g = gatewayOf(gateway), n = g.sessions.get(empire) ?? 0;
  if (n <= 0) return;
  if (n === 1) g.sessions.delete(empire);
  else g.sessions.set(empire, n - 1);
  sector.leave(empire);
});

serve<number[]>(subj.snapshot(SECTOR), (keys) => {
  const list = Array.isArray(keys) ? keys.filter(Number.isInteger).slice(0, 400) : [];
  return { t: 'chunks', list: sector.snapshots(list) } satisfies Push;
});

serve<PosMessage>(subj.pos(SECTOR), ({ empire, x, y }) => sector.report(empire, { x, y }));

serve<Heartbeat>(subj.heartbeat, ({ gateway }) => void gatewayOf(gateway));

// GDPR erasure: the accounts service deleted an account. Ack only once it's gone from disk too.
serve<{ empire: number }>(subj.accountDeleted, async ({ empire }) => {
  sector.purge(empire);
  await saver.flush();
  log.info({ empire }, 'empire purged');
  return { ok: true };
});

// Tell gateways we (re)started: whatever their clients hold may predate our last save.
nc.publish(subj.hello(SECTOR), encode({ boot: randomUUID() }));

// ---------------------------------------------------------------- loops
let last = performance.now();
const tick = setInterval(() => {
  const now = performance.now();
  sector.step(Math.min(1, (now - last) / 1000));
  last = now;
}, 100);
const saveTimer = setInterval(() => void saver.flush().catch(() => {}), SAVE_INTERVAL_MS);
const reaper = setInterval(() => {
  for (const [id, g] of gateways)
    if (Date.now() - g.seen > GATEWAY_TIMEOUT_MS) {
      log.warn({ gateway: id, players: g.sessions.size }, 'gateway went silent; logging its players out');
      for (const [empire, n] of g.sessions) for (let i = 0; i < n; i++) sector.leave(empire);
      gateways.delete(id);
    }
}, 5000);

const probes = probeServer(envInt('PORT', 3002), () => !nc.isClosed() && !fatal);
log.info('shard ready');

onShutdown(log, [
  () => clearInterval(tick),
  () => clearInterval(saveTimer),
  () => clearInterval(reaper),
  () => nc.drain(), // finish in-flight intents, stop taking new ones
  () => saver.flush(), // the final save: nothing the simulation did is lost on a clean stop
  () => db.end(),
  () => probes.close(),
]);
