// Gateway: the only thing browsers connect to for live play. It is stateless,
// so you can run as many replicas as there are sockets to hold. Per socket it:
//
//   1. checks the access token's signature (public key from the accounts JWKS),
//      so everything after this knows for certain which empire is talking;
//   2. turns socket messages into NATS requests to the sector shard, stamped
//      with that empire id (the client never gets to claim an identity);
//   3. fans shard pushes back out. Each socket joins socket.io rooms for its
//      empire, the sector and every chunk it watches; the first socket in a room
//      makes the gateway subscribe to the matching NATS subject, the last one out
//      unsubscribes. The shard publishes once per change however many players
//      watch, and NATS only delivers to gateways that have someone watching.
//
// Pushes are forwarded as the shard's encoded bytes, never decoded here.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server, Socket } from 'socket.io';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Subscription } from '@nats-io/transport-node';
import { bus, Heartbeat, IntentRequest, JoinRequest, LeaveMessage, PosMessage, subj, TokenClaims } from '@eden/kit/bus';
import { env, envInt } from '@eden/kit/env';
import { handleProbe, onShutdown } from '@eden/kit/lifecycle';
import { logger } from '@eden/kit/log';
import { decode, encode } from '@eden/shared/codec';
import type { WorldMeta } from '@eden/shared/protocol';

const SECTOR = envInt('SECTOR', 1);
const GATEWAY = `gw-${randomUUID().slice(0, 8)}`;
const log = logger('gateway').child({ gateway: GATEWAY });
const nc = await bus(env('NATS_URL', 'nats://localhost:4222'), GATEWAY, log);
const jwks = createRemoteJWKSet(new URL('/.well-known/jwks.json', env('ACCOUNTS_URL', 'http://localhost:3001')));

/** The intents a client may send (the shard validates their arguments). */
const OPS = new Set(['build', 'demolish', 'fire', 'deploy', 'cargo', 'openCache', 'board', 'refit']);
/** Most chunks a single socket may watch at once (the client caps itself well below this). */
const MAX_CHUNKS = 600;

const http = createServer((req, res) => void handleProbe(req, res, () => !nc.isClosed()));
const io = new Server(http, {
  path: '/socket.io',
  // WebSocket only: no long-polling fallback, so no sticky sessions are needed when
  // several gateway replicas sit behind one load balancer.
  transports: ['websocket'],
  serveClient: false,
  maxHttpBufferSize: 64 * 1024,
  pingInterval: 20_000,
});

// ---------------------------------------------------------------- rooms <-> NATS subjects
const bridges = new Map<string, Subscription>();
const subjectOf = (room: string) => {
  const [kind, id] = room.split(':');
  if (kind === 'p') return subj.player(SECTOR, Number(id));
  if (kind === 'c') return subj.chunk(SECTOR, Number(id));
  if (kind === 'all') return subj.all(SECTOR);
  return null; // socket.io's own per-socket rooms
};
io.of('/').adapter.on('create-room', (room: string) => {
  const subject = subjectOf(room);
  if (!subject) return;
  bridges.set(room, nc.subscribe(subject, { callback: (_err, msg) => void io.to(room).emit('m', msg.data) }));
});
io.of('/').adapter.on('delete-room', (room: string) => {
  bridges.get(room)?.unsubscribe();
  bridges.delete(room);
});

// The shard restarted: what clients hold may be ahead of its last save. Have them reload.
nc.subscribe(subj.hello(SECTOR), { callback: () => void io.emit('reset') });

// ---------------------------------------------------------------- auth
io.use(async (socket, next) => {
  try {
    const token = String(socket.handshake.auth?.token ?? '');
    const { payload } = await jwtVerify(token, jwks, { issuer: 'eden-accounts', audience: 'eden' });
    const claims = payload as unknown as TokenClaims;
    if (!Number.isInteger(claims.emp) || claims.emp <= 0) throw new Error('no empire');
    socket.data.user = { sub: payload.sub ?? '', emp: claims.emp, name: claims.name, color: claims.color } satisfies TokenClaims;
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

// ---------------------------------------------------------------- sessions
/** Open sockets per empire on this gateway, for the shard's heartbeat bookkeeping. */
const sessions = new Map<number, number>();

/** A token bucket per socket: `rate` actions a second on average, bursts up to `burst`. */
function bucket(rate: number, burst: number) {
  let tokens = burst, at = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + ((now - at) / 1000) * rate);
    at = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

io.on('connection', (socket: Socket) => {
  const user = socket.data.user as TokenClaims;
  const empire = user.emp;
  const intents = bucket(15, 40), reports = bucket(15, 30), subs = bucket(20, 60);
  let joined = false;
  log.debug({ empire }, 'socket connected');

  socket.on('join', async (ack: (m: WorldMeta | { error: string }) => void) => {
    if (typeof ack !== 'function' || joined) return;
    try {
      // Rooms first, so no push sent while the shard founds our empire is missed.
      socket.join([`p:${empire}`, 'all']);
      const req: JoinRequest = { gateway: GATEWAY, empire: { id: empire, name: user.name, color: user.color } };
      const meta = decode<WorldMeta>((await nc.request(subj.join(SECTOR), encode(req), { timeout: 10_000 })).data);
      joined = true;
      sessions.set(empire, (sessions.get(empire) ?? 0) + 1);
      ack(meta);
    } catch (e) {
      log.warn({ err: e, empire }, 'join failed');
      ack({ error: 'The sector is unavailable, retrying' });
    }
  });

  socket.on('sub', async (keys: unknown) => {
    if (!joined || !Array.isArray(keys) || !subs()) return;
    const list = keys.filter((k): k is number => Number.isInteger(k)).slice(0, 200);
    const watching = [...socket.rooms].filter((r) => r.startsWith('c:')).length;
    if (!list.length || watching + list.length > MAX_CHUNKS) return;
    socket.join(list.map((k) => `c:${k}`));
    try {
      const reply = await nc.request(subj.snapshot(SECTOR), encode(list), { timeout: 10_000 });
      socket.emit('m', reply.data);
    } catch (e) {
      log.warn({ err: e }, 'snapshot failed');
    }
  });

  socket.on('unsub', (keys: unknown) => {
    if (!Array.isArray(keys)) return;
    for (const k of keys) if (Number.isInteger(k)) socket.leave(`c:${k}`);
  });

  socket.on('i', async (op: unknown, args: unknown, ack: unknown) => {
    if (typeof ack !== 'function') return;
    if (!joined || typeof op !== 'string' || !OPS.has(op) || !Array.isArray(args)) return void ack({ ok: false, reason: 'Bad request' });
    if (!intents()) return void ack({ ok: false, reason: 'Slow down' });
    const req: IntentRequest = { empire, op, args };
    try {
      ack(decode((await nc.request(subj.intent(SECTOR), encode(req), { timeout: 5000 })).data));
    } catch {
      ack({ ok: false, reason: 'The sector did not answer, try again' });
    }
  });

  socket.on('pos', (x: unknown, y: unknown) => {
    if (!joined || typeof x !== 'number' || typeof y !== 'number' || !reports()) return;
    nc.publish(subj.pos(SECTOR), encode({ empire, x, y } satisfies PosMessage));
  });

  socket.on('disconnect', () => {
    if (!joined) return;
    const n = (sessions.get(empire) ?? 1) - 1;
    if (n > 0) sessions.set(empire, n);
    else sessions.delete(empire);
    nc.publish(subj.leave(SECTOR), encode({ gateway: GATEWAY, empire } satisfies LeaveMessage));
  });
});

// "Still here, holding these players." If this stops, the shard logs them out itself.
const beat = () => nc.publish(subj.heartbeat, encode({ gateway: GATEWAY, sessions: Object.fromEntries(sessions) } satisfies Heartbeat));
const heartbeat = setInterval(beat, 10_000);
beat();

const port = envInt('PORT', 3000);
http.listen(port, () => log.info({ port }, 'gateway ready'));

onShutdown(log, [
  () => clearInterval(heartbeat),
  // Closing sockets fires their disconnects (and leaves) while NATS is still up.
  () => new Promise((r) => io.close(() => r(null))),
  () => nc.drain(),
]);
