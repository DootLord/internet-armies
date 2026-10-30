// Cargo holds: a grid you pack items into, Tetris-style. Pure functions, like
// fitting.ts, so the server can validate every move with exactly this code.
//
// The grid's size comes from the ship's cargo stat. Items keep their grid
// position; anything that ends up outside the grid (a refit shrank the hold)
// is "overflow": still owned, shown in a tray, and never silently destroyed.

export type ItemKind = 'ore' | 'shard' | 'scrap' | 'fuelcell' | 'relic';

export interface ItemDef {
  kind: ItemKind;
  name: string;
  desc: string;
  /** Footprint in cells, before rotation. */
  w: number;
  h: number;
}

export const ITEMS: Record<ItemKind, ItemDef> = {
  ore: { kind: 'ore', name: 'Ferrite Ore', desc: 'Raw metallic ore cut from a Ferrite Vein. Refines into alloy.', w: 2, h: 2 },
  shard: { kind: 'shard', name: 'Resonant Shard', desc: 'A palm-sized crystal that hums with stored charge.', w: 1, h: 1 },
  scrap: { kind: 'scrap', name: 'Hull Scrap', desc: 'Bent plating stripped from a wreck. Salvageable.', w: 2, h: 1 },
  fuelcell: { kind: 'fuelcell', name: 'Fuel Cell', desc: 'A sealed canister of reactor fuel.', w: 1, h: 2 },
  relic: { kind: 'relic', name: 'Precursor Relic', desc: 'Alien machinery of unknown purpose. Collectors pay well.', w: 3, h: 2 },
};

/** What a cache can hold, by weight. Relics are rare. */
export const LOOT: [ItemKind, number][] = [['ore', 35], ['scrap', 30], ['shard', 20], ['fuelcell', 12], ['relic', 3]];

/** Roll a cache's contents: two to four items. `rnd` returns [0, 1), so the shard can seed it. */
export function rollLoot(rnd: () => number): ItemKind[] {
  const total = LOOT.reduce((n, [, w]) => n + w, 0);
  return Array.from({ length: 2 + Math.floor(rnd() * 3) }, () => {
    let r = rnd() * total;
    for (const [k, w] of LOOT) if ((r -= w) < 0) return k;
    return LOOT[0][0];
  });
}

export interface CargoItem {
  uid: number;
  kind: ItemKind;
  x: number;
  y: number;
  /** Rotated a quarter turn: footprint is h x w. */
  rot: boolean;
}

export interface Grid {
  w: number;
  h: number;
}

export const CARGO_COLS = 8;
/** A Storage building's hold: a big fixed bay. */
export const STORAGE_GRID: Grid = { w: 12, h: 10 };
/** World px a ship must be within to open a cache or reach a Storage. */
export const CACHE_RANGE = 60;
export const STORAGE_RANGE = 90;
/** Seconds before an opened cache restocks. */
export const CACHE_RESPAWN = 240;

/**
 * Cargo stat to grid size. Square-root scaling keeps holds readable: a Wisp
 * gets two rows, a Lancer three, a Mule a deep scrolling bay, and every Hold
 * Expander still adds space.
 */
export function cargoGrid(cargo: number): Grid {
  const cells = 1.5 * Math.sqrt(Math.max(0, cargo));
  return { w: CARGO_COLS, h: Math.max(2, Math.round(cells / CARGO_COLS)) };
}

export function footprint(it: Pick<CargoItem, 'kind' | 'rot'>): [number, number] {
  const d = ITEMS[it.kind];
  return it.rot ? [d.h, d.w] : [d.w, d.h];
}

export function inGrid(it: CargoItem, g: Grid) {
  const [w, h] = footprint(it);
  return it.x >= 0 && it.y >= 0 && it.x + w <= g.w && it.y + h <= g.h;
}

const overlaps = (a: CargoItem, b: CargoItem) => {
  const [aw, ah] = footprint(a), [bw, bh] = footprint(b);
  return a.x < b.x + bw && b.x < a.x + aw && a.y < b.y + bh && b.y < a.y + ah;
};

/** Can `it` sit where it says, ignoring itself (by uid) and anything in overflow? */
export function canPlace(items: CargoItem[], g: Grid, it: CargoItem) {
  return inGrid(it, g) && items.every((o) => o.uid === it.uid || !inGrid(o, g) || !overlaps(o, it));
}

/** First free spot, scanning row by row, trying both orientations. */
export function findSpot(items: CargoItem[], g: Grid, kind: ItemKind): Pick<CargoItem, 'x' | 'y' | 'rot'> | null {
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++)
      for (const rot of [false, true])
        if (canPlace(items, g, { uid: -1, kind, x, y, rot })) return { x, y, rot };
  return null;
}

/** Stow a new item in the first free spot, or null if the hold is full. The shard hands out uids. */
export function addItem(items: CargoItem[], g: Grid, kind: ItemKind, uid: number): CargoItem[] | null {
  const spot = findSpot(items, g, kind);
  return spot ? [...items, { uid, kind, ...spot }] : null;
}

/** Drop an item arriving from another hold at a chosen spot, or null if it doesn't fit there. */
export function insertItem(items: CargoItem[], g: Grid, it: CargoItem): CargoItem[] | null {
  return canPlace(items, g, it) ? [...items, it] : null;
}

/** Move (and maybe rotate) an item. Returns the new list, or null if it doesn't fit there. */
export function moveItem(items: CargoItem[], g: Grid, uid: number, x: number, y: number, rot: boolean): CargoItem[] | null {
  const it = items.find((o) => o.uid === uid);
  if (!it) return null;
  const moved = { ...it, x, y, rot };
  return canPlace(items, g, moved) ? items.map((o) => (o.uid === uid ? moved : o)) : null;
}

export const removeItem = (items: CargoItem[], uid: number) => items.filter((o) => o.uid !== uid);

/** Cells occupied by items in the grid, for "x / y" readouts. */
export const usedCells = (items: CargoItem[], g: Grid) =>
  items.filter((it) => inGrid(it, g)).reduce((n, it) => n + ITEMS[it.kind].w * ITEMS[it.kind].h, 0);
