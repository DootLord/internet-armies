// End-to-end smoke test against a running stack (docker compose up), playing
// the way two browsers would. Run: npx tsx scripts/smoke.ts [phase]
//
//   play     two guests join, build, see each other's work; cheats get refused.
//            Saves player A's session to .smoke.json for the next phase.
//   restart  (after `docker compose restart shard`) A signs back in: is the build still there?
//   erase    B deletes their account: their empire vanishes from the world.
import fs from 'node:fs';
import { io, Socket } from 'socket.io-client';
import { chunkKeyOf } from '@eden/shared/chunks';
import { decode } from '@eden/shared/codec';
import type { ChunkSnapshot, Push, WorldMeta } from '@eden/shared/protocol';

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const STATE = '.smoke.json';
const phase = process.argv[2] ?? 'play';
let failures = 0;

const check = (ok: unknown, what: string) => {
  console.log(`${ok ? '  ok ' : ' FAIL'}  ${what}`);
  if (!ok) failures++;
};

async function post(path: string, body?: unknown, token?: string, method = 'POST') {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: r.status, json: (r.status === 204 ? null : await r.json().catch(() => null)) as any };
}

interface Player {
  socket: Socket;
  meta: WorldMeta;
  pushes: Push[];
  session: string;
  token: string;
  ask: (op: string, ...args: unknown[]) => Promise<{ ok: boolean; reason?: string }>;
  chunks: (keys: number[]) => Promise<ChunkSnapshot[]>;
}

async function connect(session?: string): Promise<Player> {
  const auth = session ? await post('/auth/token', { session }) : await post('/auth/guest');
  if (auth.status >= 300) throw new Error(`auth failed: ${auth.status}`);
  const token = auth.json.token as string;
  const socket = io(BASE, { path: '/socket.io', transports: ['websocket'], auth: { token } });
  const pushes: Push[] = [];
  socket.on('m', (b: Buffer) => pushes.push(decode<Push>(new Uint8Array(b))));
  await new Promise<void>((res, rej) => {
    socket.once('connect', res);
    socket.once('connect_error', rej);
  });
  const meta = (await socket.emitWithAck('join')) as WorldMeta;
  return {
    socket, meta, pushes, token, session: session ?? auth.json.session,
    ask: (op, ...args) => socket.timeout(8000).emitWithAck('i', op, args),
    chunks: async (keys) => {
      const before = pushes.length;
      socket.emit('sub', keys);
      for (let i = 0; i < 50; i++) {
        const got = pushes.slice(before).find((p) => p.t === 'chunks');
        if (got && got.t === 'chunks') return got.list;
        await sleep(100);
      }
      throw new Error('no snapshot');
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const home = (p: Player) => p.meta.homes[p.meta.player];
const structuresAt = (list: ChunkSnapshot[], col: number, row: number) => list.flatMap((c) => c.structures).filter((s) => s.col === col && s.row === row);

if (phase === 'play') {
  console.log('-- accounts');
  const unauth = io(BASE, { path: '/socket.io', transports: ['websocket'], auth: { token: 'forged' } });
  const refused = await new Promise((r) => { unauth.once('connect_error', () => r(true)); unauth.once('connect', () => r(false)); });
  unauth.close();
  check(refused, 'a forged token is refused at the gateway');

  const a = await connect(), b = await connect();
  check(a.meta.player !== b.meta.player, `two guests get different empires (${a.meta.player}, ${b.meta.player})`);
  const ha = home(a), hb = home(b);
  check(ha && hb && (ha.col !== hb.col || ha.row !== hb.row), 'and separate homes');

  console.log('-- building');
  let spot: [number, number] | null = null;
  for (let dr = -2; dr <= 2 && !spot; dr++)
    for (let dc = -2; dc <= 2 && !spot; dc++) {
      const r = await a.ask('build', 'solar', ha.col + dc, ha.row + dr);
      if (r.ok) spot = [ha.col + dc, ha.row + dr];
    }
  check(spot, `A builds a Solar Array at ${spot}`);
  const ck = chunkKeyOf(...spot!);
  const seen = await b.chunks([ck]);
  check(structuresAt(seen, ...spot!).some((s) => s.kind === 'solar' && s.owner === a.meta.player), "B's snapshot of that chunk shows A's Solar Array");
  const r2 = await b.ask('build', 'solar', ha.col, ha.row + 1);
  check(!r2.ok, `B can't build in A's territory (${r2.reason})`);

  console.log('-- trust boundary');
  check(!(await a.ask('build', 'nexus', ha.col + 5, ha.row)).ok, 'building a second Nexus is refused');
  check((await a.ask('build', 'solar', 'x', null)).reason === 'Malformed request', 'malformed arguments are refused before the simulation');
  check((await a.ask('demolish', hb.col, hb.row)).ok === false, "A can't demolish B's Nexus");
  a.socket.emit('pos', a.meta.ship.x + 9000, a.meta.ship.y);
  await sleep(500);
  check(a.pushes.some((p) => p.t === 'correct'), 'a teleport report gets a correction back');

  fs.writeFileSync(STATE, JSON.stringify({ a: a.session, b: b.session, bToken: b.token, spot, bHome: hb, aEmpire: a.meta.player }));
  a.socket.close();
  b.socket.close();
} else if (phase === 'restart') {
  const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const a = await connect(s.a);
  check(a.meta.player === s.aEmpire, 'A signs back in to the same empire');
  const list = await a.chunks([chunkKeyOf(...(s.spot as [number, number]))]);
  check(structuresAt(list, ...(s.spot as [number, number])).some((x) => x.kind === 'solar'), "A's Solar Array survived the shard restart");
  a.socket.close();
} else if (phase === 'erase') {
  const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const b = await post('/auth/token', { session: s.b });
  const del = await post('/auth/me', undefined, b.json.token, 'DELETE');
  check(del.status === 204, 'B deletes their account');
  check((await post('/auth/token', { session: s.b })).status === 401, "B's session no longer works");
  const a = await connect(s.a);
  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) {
    await sleep(500);
    a.socket.emit('unsub', [chunkKeyOf(s.bHome.col, s.bHome.row)]);
    const list = await a.chunks([chunkKeyOf(s.bHome.col, s.bHome.row)]);
    gone = structuresAt(list, s.bHome.col, s.bHome.row).length === 0;
  }
  check(gone, "B's Nexus is erased from the world (outbox -> NATS -> shard)");
  a.socket.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
