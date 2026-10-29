import { PLAYER, Res, StructureKind, TileKind } from './defs';
import type { Engine } from './engine';
import { createStore } from './store';
import { World, WorldEvent } from './world';

export interface TileSnap {
  col: number;
  row: number;
  kind: TileKind;
  variant: number;
  owner: number;
  structure: null | { kind: StructureKind; progress: number; level: number; owner: number };
  ok?: boolean;
  reason?: string;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'bad' | 'good' | 'info';
}

export interface HudState {
  res: Res;
  rates: Res;
  hover: TileSnap | null;
  selected: TileSnap | null;
  buildMode: StructureKind | null;
  feed: WorldEvent[];
  cycle: number;
  toasts: Toast[];
  sectors: number;
  zoom: number;
}

export const world = new World(20261029);

export const hud = createStore<HudState>({
  res: { ...world.res },
  rates: world.rates(PLAYER),
  hover: null,
  selected: null,
  buildMode: null,
  feed: world.log,
  cycle: world.cycle,
  toasts: [],
  sectors: world.ownedTiles(PLAYER).length,
  zoom: 3,
});

world.onEvent(() => hud.set({ feed: world.log }));

let toastId = 1;
export function toast(text: string, tone: Toast['tone'] = 'info') {
  const t = { id: toastId++, text, tone };
  hud.set({ toasts: [...hud.get().toasts, t].slice(-3) });
  setTimeout(() => hud.set({ toasts: hud.get().toasts.filter((x) => x.id !== t.id) }), 2600);
}

let engine: Engine | null = null;
export const getEngine = () => engine;
export const setEngine = (e: Engine | null) => { engine = e; };
