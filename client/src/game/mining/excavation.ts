// The mining dig: a slab of layered rock with finds buried in it, cut away
// with a ship's mining laser. Pure (no DOM): a seed and a node kind always
// make the same slab, so a server can later roll the contents and check a
// result against them.
//
//   cells: a stack of stone per grid cell, bottom -> top. The laser wears down
//          the top layer; when its hp runs out the layer pops off.
//   finds: items lying on the bedrock under the stacks. A find is pulled free
//          once FREE_AT of the cells over it are clear, and lost if the
//          Cutter's core is held on it too long (the Precision beam is safe).
import { ItemKind } from '../ships/cargo';
import { hash2, mulberry32 } from '../rng';

export type NodeKind = 'ore' | 'crystal' | 'ruin';
export type Stone = 'regolith' | 'basalt' | 'obsidian';

export const COLS = 28;
export const ROWS = 18;
export const DEPTH = 3;

/** Seconds of full-power cutting a layer of each stone takes at the centre of the beam. */
export const STONE: Record<Stone, { hp: number; name: string }> = {
  regolith: { hp: 0.15, name: 'Regolith' },
  basalt: { hp: 0.4, name: 'Basalt' },
  obsidian: { hp: 1, name: 'Obsidian' },
};

export interface Tool {
  id: 'cutter' | 'precision';
  name: string;
  desc: string;
  /** Beam radius in cells; damage falls off toward the edge. */
  radius: number;
  power: number;
  /** Heat gained per second of firing (1 = overheated). */
  heat: number;
  /** Charge spent per second of firing. */
  drain: number;
  /** Integrity a find loses per second under the beam's centre. */
  wear: number;
  /** Share of the radius that hurts finds: the beam's hot core. */
  core: number;
}

export const TOOLS: Tool[] = [
  { id: 'cutter', name: 'Cutter', desc: 'Wide, fast beam. Burns a find if you hold it right on one.', radius: 2.6, power: 1.6, heat: 0.18, drain: 3, wear: 0.5, core: 0.45 },
  { id: 'precision', name: 'Precision', desc: 'Narrow beam that never harms finds. For the last bits around them.', radius: 1.5, power: 1.1, heat: 0.08, drain: 1.5, wear: 0, core: 0 },
];

/** Grid footprint (cells) of each kind of find: roughly its model's size at one art px per voxel. */
export const FOOTPRINT: Record<ItemKind, [number, number]> = { ore: [4, 3], shard: [2, 2], scrap: [4, 2], fuelcell: [2, 4], relic: [6, 4] };

export const NODE: Record<NodeKind, { name: string; desc: string }> = {
  ore: { name: 'Ore seam', desc: 'Soft regolith over ferrite ore.' },
  crystal: { name: 'Crystal pocket', desc: 'Hard basalt and obsidian around fragile shards.' },
  ruin: { name: 'Buried wreck', desc: 'Salvage under rubble. Something old may be down there.' },
};

export interface Find {
  id: number;
  kind: ItemKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 1 = pristine, 0 = destroyed. */
  integrity: number;
  state: 'buried' | 'recovered' | 'lost';
}

/** What one tick of the beam did, for the renderer's effects. */
export interface BurnResult {
  popped: { x: number; y: number; stone: Stone }[];
  recovered: Find[];
  lost: Find[];
  /** The beam is touching an exposed find. */
  grazing: boolean;
}

/** A find comes free once this share of the cells over it is clear: no need to scrape every corner. */
export const FREE_AT = 0.75;
export const COOL_RATE = 0.45;
/** After overheating the laser stays locked until heat falls this low. */
export const RESUME_HEAT = 0.5;
export const MAX_CHARGE = 100;
export const SCANS = 2;

/** Smooth value noise in 0..1 from the integer hash, for stone pockets and thickness. */
function noise(x: number, y: number, seed: number) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, seed), b = hash2(x0 + 1, y0, seed), c = hash2(x0, y0 + 1, seed), d = hash2(x0 + 1, y0 + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

export class Dig {
  /** Stone stacks, bottom first, by cell index (y * COLS + x). */
  readonly cells: Stone[][] = [];
  /** Hit points left in each cell's top layer. */
  readonly hp = new Float32Array(COLS * ROWS);
  readonly finds: Find[] = [];
  heat = 0;
  overheated = false;
  charge = MAX_CHARGE;
  scans = SCANS;

  constructor(readonly seed: number, readonly node: NodeKind) {
    const rnd = mulberry32(seed);
    const pocket = node === 'crystal' ? 0.55 : node === 'ruin' ? 0.68 : 0.78;
    for (let y = 0; y < ROWS; y++)
      for (let x = 0; x < COLS; x++) {
        const n = noise(x / 5, y / 4, seed + 3);
        const thick = n < 0.45 ? 2 : DEPTH;
        const stack: Stone[] = [];
        for (let k = 0; k < thick; k++) {
          const hard = noise(x / 4 + k * 7, y / 3, seed + 11 + k);
          if (k === thick - 1 && node !== 'crystal') stack.push('regolith');
          else stack.push(hard > pocket ? 'obsidian' : k === thick - 1 && hard < 0.4 ? 'regolith' : 'basalt');
        }
        this.cells.push(stack);
        this.hp[y * COLS + x] = STONE[stack[stack.length - 1]].hp;
      }
    for (const kind of this.roll(rnd)) this.bury(kind, rnd);
  }

  /** What this node holds. A real shard would roll this server-side from the same seed. */
  private roll(rnd: () => number): ItemKind[] {
    const n = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    if (this.node === 'ore') return [...Array(n(3, 4)).fill('ore'), ...(rnd() < 0.5 ? ['shard'] : []), ...(rnd() < 0.4 ? ['scrap'] : [])];
    if (this.node === 'crystal') return [...Array(n(4, 6)).fill('shard'), ...(rnd() < 0.3 ? ['relic'] : [])];
    return [...Array(n(2, 3)).fill('scrap'), 'fuelcell', ...(rnd() < 0.55 ? ['relic'] : [])];
  }

  /** Lay a find on the bedrock where it doesn't touch another, under at least two layers. */
  private bury(kind: ItemKind, rnd: () => number) {
    const [w, h] = FOOTPRINT[kind];
    for (let tries = 0; tries < 200; tries++) {
      const x = 1 + Math.floor(rnd() * (COLS - w - 1)), y = 1 + Math.floor(rnd() * (ROWS - h - 1));
      if (this.finds.some((f) => x < f.x + f.w + 1 && f.x < x + w + 1 && y < f.y + f.h + 1 && f.y < y + h + 1)) continue;
      for (let j = y; j < y + h; j++)
        for (let i = x; i < x + w; i++) {
          const s = this.cells[j * COLS + i];
          while (s.length < 2) s.unshift('basalt');
          this.hp[j * COLS + i] = STONE[s[s.length - 1]].hp;
        }
      this.finds.push({ id: this.finds.length, kind, x, y, w, h, integrity: 1, state: 'buried' });
      return;
    }
  }

  layers(x: number, y: number) {
    return x < 0 || y < 0 || x >= COLS || y >= ROWS ? 0 : this.cells[y * COLS + x].length;
  }

  findAt(x: number, y: number) {
    return this.finds.find((f) => f.state === 'buried' && x >= f.x && x < f.x + f.w && y >= f.y && y < f.y + f.h);
  }

  /** Share of a find's cells with no stone left on them. */
  exposure(f: Find) {
    let clear = 0;
    for (let j = f.y; j < f.y + f.h; j++) for (let i = f.x; i < f.x + f.w; i++) if (!this.cells[j * COLS + i].length) clear++;
    return clear / (f.w * f.h);
  }

  get canFire() {
    return !this.overheated && this.charge > 0;
  }

  get done() {
    return this.charge <= 0 || this.finds.every((f) => f.state !== 'buried');
  }

  /** Recovered finds, as cargo items. */
  get haul(): ItemKind[] {
    return this.finds.filter((f) => f.state === 'recovered').map((f) => f.kind);
  }

  /** One tick of the beam centred on (cx, cy) in cell units. */
  fire(tool: Tool, cx: number, cy: number, dt: number): BurnResult {
    const out: BurnResult = { popped: [], recovered: [], lost: [], grazing: false };
    if (!this.canFire) return out;
    this.heat = Math.min(1, this.heat + tool.heat * dt);
    if (this.heat >= 1) this.overheated = true;
    this.charge = Math.max(0, this.charge - tool.drain * dt);
    // Each find takes the hardest hit among its exposed cells, once per tick (not once per cell).
    const r = tool.radius, hits = new Map<Find, number>();
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue;
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d > r) continue;
        const i = y * COLS + x, stack = this.cells[i];
        if (stack.length) {
          this.hp[i] -= tool.power * (1 - (d / r) * 0.7) * dt;
          if (this.hp[i] <= 0) {
            out.popped.push({ x, y, stone: stack.pop()! });
            this.hp[i] = stack.length ? STONE[stack[stack.length - 1]].hp : 0;
          }
        } else if (tool.wear > 0 && d <= r * tool.core) {
          // Bare cells over a find: only the beam's hot core burns it.
          const find = this.findAt(x, y);
          if (find) hits.set(find, Math.max(hits.get(find) ?? 0, 1 - d / (r * tool.core)));
        }
      }
    for (const [find, k] of hits) {
      out.grazing = true;
      find.integrity -= tool.wear * k * dt;
      if (find.integrity <= 0) {
        find.integrity = 0;
        find.state = 'lost';
        out.lost.push(find);
      }
    }
    for (const f of this.finds)
      if (f.state === 'buried' && this.exposure(f) >= FREE_AT) {
        f.state = 'recovered';
        out.recovered.push(f);
      }
    return out;
  }

  /** The laser cools whenever it isn't firing. */
  cool(dt: number) {
    this.heat = Math.max(0, this.heat - COOL_RATE * dt);
    if (this.overheated && this.heat <= RESUME_HEAT) this.overheated = false;
  }

  scan() {
    if (this.scans <= 0) return false;
    this.scans--;
    return true;
  }
}
