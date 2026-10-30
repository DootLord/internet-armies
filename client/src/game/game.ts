import { emptyRes, Res, StructureKind, TileKind } from './defs';
import type { Engine } from './engine';
import type { CargoState, WorldEvent } from './protocol';
import type { FleetState, ShipRecord } from './ships/fleet';
import type { Vitals } from './ships/vitals';
import { LocalShard } from './sim/LocalShard';
import { createStore } from './store';
import { WorldView } from './WorldView';

export interface TileSnap {
  col: number;
  row: number;
  kind: TileKind;
  variant: number;
  owner: number;
  structure: null | { id: number; kind: StructureKind; progress: number; level: number; owner: number; finishAt: number; hp: number; maxHp: number };
  /** False while the chunk's live state hasn't arrived yet. */
  known: boolean;
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
  pilot: boolean;
  /** G: the flown ship's loadout and cargo. */
  shipOpen: boolean;
  /** Hangar whose window is open (structure id). */
  hangarOpen: number | null;
  /** Mouse mode: aiming weapons rather than selecting and placing. */
  aim: boolean;
  /** Storage Bay whose window is open (structure id). */
  storageOpen: number | null;
  /** Picking an enemy structure for a Mech Bay squad to assault. */
  deploying: boolean;
  ship: Vitals & { refuelling: boolean; repairing: boolean; wrecked: boolean; firing: boolean };
}

// ?radius=40000 (world px) for stress tests; the default disc is ~0.9M hex slots.
const q = new URLSearchParams(location.search);
export const source = new LocalShard({ seed: 20261029, radiusPx: Number(q.get('radius')) || 14000, latencyMs: Number(q.get('latency') ?? 60) });
export const world = new WorldView(source);

export const hud = createStore<HudState>({
  res: emptyRes(),
  rates: emptyRes(),
  hover: null,
  selected: null,
  buildMode: null,
  feed: [],
  cycle: 0,
  toasts: [],
  sectors: 0,
  zoom: 3,
  pilot: false,
  shipOpen: false,
  hangarOpen: null,
  aim: false,
  storageOpen: null,
  deploying: false,
  ship: { hp: 0, maxHp: 0, fuel: 0, maxFuel: 0, refuelling: false, repairing: false, wrecked: false, firing: false },
});

/** Cargo as the client shows it: the shard's state, with the player's moves applied ahead of confirmation. */
export const cargo = createStore<CargoState>({ holds: {}, stores: {} });
/** The player's ships, as the shard reports them (refits applied ahead of confirmation). */
export const fleet = createStore<FleetState>({ ships: [], flying: 0 });
export const flyingShip = (f: FleetState = fleet.get()): ShipRecord | undefined => f.ships.find((s) => s.id === f.flying);

world.listeners = {
  cargo: (c) => cargo.set(c),
  fleet: (f) => fleet.set(f),
  event: () => hud.set({ feed: world.log }),
  player: (p) => hud.set({ res: p.res, rates: p.rates, sectors: p.sectors, cycle: p.cycle }),
};

let toastId = 1;
export function toast(text: string, tone: Toast['tone'] = 'info') {
  const t = { id: toastId++, text, tone };
  hud.set({ toasts: [...hud.get().toasts, t].slice(-3) });
  setTimeout(() => hud.set({ toasts: hud.get().toasts.filter((x) => x.id !== t.id) }), 2600);
}

let engine: Engine | null = null;
export const getEngine = () => engine;
export const setEngine = (e: Engine | null) => { engine = e; };
