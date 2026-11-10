// Ground troops: Mech Bay units, their routes and the Pulse Batteries that
// shoot them. Pure, like ships/cargo.ts, so the shard and every client agree:
// a squad's position is a function of server time along a fixed route.
import { pack } from './chunks';
import { hexDist, neighbor } from './hex';
import { hpOf, Squad } from './protocol';
import { tileCenterX, tileCenterY, VOID } from './terrain';

/** One assault mech per deployment. The pool/size model still allows multi-unit squads later. */
export const SQUAD_SIZE = 1;
export const TROOPER_HP = 260;
/** Damage per second once it reaches the target. */
export const TROOPER_DPS = 34;
/** Walking speed in world px per second. */
export const TROOPER_SPEED = 30;
export const SQUAD_COST = { credits: 60, alloy: 30 };
/** Seconds a Mech Bay needs between squads. */
export const DEPLOY_COOLDOWN = 10;
/** Pulse Batteries engage enemy squads within this many world px. */
export const TURRET_RANGE = 150;
export const TURRET_DPS = 30;
/** When a squad's target falls, it looks for another enemy structure this close. */
export const RETARGET_RANGE = 320;
/** Give up on targets further than this many hexes of walking. */
const SEARCH_LIMIT = 60000;
/** Walking through a building tile is allowed but costs this much more, so squads go round bases. */
const STRUCTURE_COST = 6;

export const squadMaxHp = (q: Squad) => q.size * TROOPER_HP;
/** Troopers still standing: the pool falls in TROOPER_HP steps. */
export const aliveOf = (q: Squad, now: number) => Math.max(0, Math.ceil(hpOf(q, now) / TROOPER_HP - 1e-6));

export function routeLength(route: number[]) {
  let d = 0;
  for (let i = 2; i < route.length; i += 2) d += Math.hypot(route[i] - route[i - 2], route[i + 1] - route[i - 1]);
  return d;
}

export const arriveAt = (q: Squad) => q.startAt + routeLength(q.route) / q.speed;

/** Where the squad's centre is at server time `now`, which way it's facing, and whether it has arrived. */
export function squadAt(q: Squad, now: number) {
  const r = q.route;
  let left = Math.max(0, now - q.startAt) * q.speed;
  for (let i = 2; i < r.length; i += 2) {
    const dx = r[i] - r[i - 2], dy = r[i + 1] - r[i - 1], d = Math.hypot(dx, dy);
    if (left <= d && d > 0) return { x: r[i - 2] + (dx * left) / d, y: r[i - 1] + (dy * left) / d, dx: dx / d, dy: dy / d, arrived: false };
    left -= d;
  }
  const n = r.length;
  const dx = n >= 4 ? r[n - 2] - r[n - 4] : 1, dy = n >= 4 ? r[n - 1] - r[n - 3] : 0, d = Math.hypot(dx, dy) || 1;
  return { x: r[n - 2], y: r[n - 1], dx: dx / d, dy: dy / d, arrived: true };
}

export interface PathWorld {
  kindId(col: number, row: number): number;
  structure(col: number, row: number): unknown;
}

/**
 * A* over land hexes from `from` to the tile next to `to`. Squads stop
 * beside the target, not on it. Returns the tiles walked (including the
 * start), or null if the target can't be reached on foot.
 */
export function findPath(w: PathWorld, from: [number, number], to: [number, number]): [number, number][] | null {
  const [tc, tr] = to, key = (c: number, r: number) => pack(c, r);
  const g = new Map<number, number>(), prev = new Map<number, number>(), at = new Map<number, [number, number]>();
  const heap: [number, number][] = []; // [f, key]
  const push = (f: number, k: number) => {
    heap.push([f, k]);
    for (let i = heap.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const a = 2 * i + 1, b = a + 1;
        let m = i;
        if (a < heap.length && heap[a][0] < heap[m][0]) m = a;
        if (b < heap.length && heap[b][0] < heap[m][0]) m = b;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const k0 = key(...from);
  g.set(k0, 0);
  at.set(k0, from);
  push(hexDist(...from, tc, tr), k0);
  let seen = 0;
  while (heap.length && seen++ < SEARCH_LIMIT) {
    const [f, k] = pop();
    const [c, r] = at.get(k)!, gk = g.get(k)!;
    if (f > gk + hexDist(c, r, tc, tr) + 1e-9) continue; // stale entry
    if (hexDist(c, r, tc, tr) <= 1) {
      const out: [number, number][] = [];
      for (let p: number | undefined = k; p !== undefined; p = prev.get(p)) out.push(at.get(p)!);
      return out.reverse();
    }
    for (let d = 0; d < 6; d++) {
      const [nc, nr] = neighbor(c, r, d), nk = key(nc, nr);
      if (w.kindId(nc, nr) === VOID) continue;
      const ng = gk + (w.structure(nc, nr) ? STRUCTURE_COST : 1);
      if (ng >= (g.get(nk) ?? Infinity)) continue;
      g.set(nk, ng);
      prev.set(nk, k);
      at.set(nk, [nc, nr]);
      push(ng + hexDist(nc, nr, tc, tr), nk);
    }
  }
  return null;
}

/** Points every `step` px along the route from distance `from` to its end, for drawing the march ahead. */
export function routeDots(route: number[], from: number, step: number) {
  const out: number[] = [];
  let walked = 0, next = from + step;
  for (let i = 2; i < route.length; i += 2) {
    const x0 = route[i - 2], y0 = route[i - 1], dx = route[i] - x0, dy = route[i + 1] - y0, d = Math.hypot(dx, dy);
    for (; next <= walked + d; next += step) {
      const u = (next - walked) / d;
      out.push(x0 + dx * u, y0 + dy * u);
    }
    walked += d;
  }
  return out;
}

/** Tile path to a flat route of world points, starting from an exact point (the squad's current spot). */
export function routeFrom(x: number, y: number, path: [number, number][]) {
  const route = [x, y];
  for (const [c, r] of path.slice(1)) route.push(tileCenterX(c, r), tileCenterY(r));
  if (route.length === 2) route.push(x, y);
  return route;
}

/** Where trooper `i` stands relative to the squad's centre: a loose wedge marching, a ring once it arrives. */
export function trooperOffset(i: number, n: number, dx: number, dy: number, arrived: boolean): [number, number] {
  if (n <= 1) return [0, 0];
  if (arrived) {
    const a = (i / Math.max(1, n)) * Math.PI * 2 + 0.4;
    return [Math.cos(a) * 14, Math.sin(a) * 8];
  }
  const row = Math.floor(i / 2), side = i % 2 ? 1 : -1;
  const back = row * 10, across = side * (5 + row * 2.5);
  return [-dx * back - dy * across, (-dy * back + dx * across) * 0.6];
}
