import { hex, RGB } from './palette';

export type TileKind = 'void' | 'plate' | 'rock' | 'ore' | 'crystal' | 'ice' | 'gas' | 'ruin' | 'cache' | 'cacheOpen';
export const TILE_KINDS: Exclude<TileKind, 'void'>[] = ['plate', 'rock', 'ore', 'crystal', 'ice', 'gas', 'ruin', 'cache', 'cacheOpen'];

export type ResKey = 'credits' | 'alloy' | 'energy' | 'crystal';
export type Res = Record<ResKey, number>;
export const RES_KEYS: ResKey[] = ['credits', 'alloy', 'energy', 'crystal'];
export const RES_INFO: Record<ResKey, { name: string; color: string }> = {
  credits: { name: 'Credits', color: '#ffd36b' },
  alloy: { name: 'Alloy', color: '#b8c8dc' },
  energy: { name: 'Energy', color: '#6df2ff' },
  crystal: { name: 'Crystal', color: '#c39bff' },
};
export const emptyRes = (): Res => ({ credits: 0, alloy: 0, energy: 0, crystal: 0 });

export const TILE_INFO: Record<TileKind, { name: string; desc: string; deposit?: Partial<Res> }> = {
  void: { name: 'Deep Void', desc: 'Nothing to build on.' },
  plate: { name: 'Deck Plating', desc: 'Pre-fabricated hull plating. Ideal foundations.' },
  rock: { name: 'Asteroid Crust', desc: 'Dense regolith. Stable, unremarkable.' },
  ore: { name: 'Ferrite Vein', desc: 'Exposed metallic ore.', deposit: { alloy: 5 } },
  crystal: { name: 'Resonant Crystal', desc: 'Lattice crystals humming with charge.', deposit: { crystal: 2 } },
  ice: { name: 'Cryo Shelf', desc: 'Frozen volatiles, crackable for fuel.', deposit: { energy: 4 } },
  gas: { name: 'Plasma Vent', desc: 'Ionised gas escaping from the core.', deposit: { energy: 5, credits: 1 } },
  ruin: { name: 'Derelict Wreck', desc: 'Salvage from a forgotten war.' },
  cache: { name: 'Sealed Cache', desc: 'A drifting supply pod. Bases can’t touch it: fly a ship close and crack it open.' },
  cacheOpen: { name: 'Spent Cache', desc: 'Already looted. Salvage crews restock it in time.' },
};

export type StructureKind = 'nexus' | 'extractor' | 'solar' | 'habitat' | 'turret' | 'shield' | 'relay' | 'dronebay' | 'mechbay' | 'depot' | 'repair' | 'storage' | 'hangar';

export interface StructureDef {
  kind: StructureKind;
  name: string;
  role: string;
  desc: string;
  cost: Partial<Res>;
  buildTime: number;
  /** 'owned' = inside your territory, 'deposit' = owned resource tile, 'frontier' = unclaimed tile bordering you. */
  place: 'owned' | 'deposit' | 'frontier' | 'none';
  produce: (tile: TileKind) => Partial<Res>;
  claim?: number;
  light: number;
  /** Structure points: how much fire it takes to destroy. */
  hp: number;
}

export const STRUCTURES: StructureDef[] = [
  { kind: 'nexus', name: 'Command Nexus', role: 'Core', desc: "A faction's seat of power. Claims the surrounding sectors.", cost: {}, buildTime: 1, place: 'none', produce: () => ({ credits: 4, alloy: 2, energy: 6 }), claim: 3, light: 70, hp: 6000 },
  { kind: 'extractor', name: 'Deep Extractor', role: 'Economy', desc: 'Drills deposits for alloy, crystal or energy.', cost: { credits: 120, alloy: 40 }, buildTime: 10, place: 'deposit', produce: (t) => ({ ...TILE_INFO[t].deposit, energy: (TILE_INFO[t].deposit?.energy ?? 0) - 1 }), light: 40, hp: 900 },
  { kind: 'solar', name: 'Solar Array', role: 'Power', desc: 'Harvests starlight. Cheap, reliable energy.', cost: { credits: 80, alloy: 30 }, buildTime: 7, place: 'owned', produce: () => ({ energy: 4 }), light: 34, hp: 600 },
  { kind: 'habitat', name: 'Habitat Ring', role: 'Economy', desc: 'Houses crews and generates credits.', cost: { credits: 150, alloy: 80 }, buildTime: 14, place: 'owned', produce: () => ({ credits: 5, energy: -2 }), light: 48, hp: 1400 },
  { kind: 'turret', name: 'Pulse Battery', role: 'Defense', desc: 'Point-defense cannons. Shoots enemy troopers that come in range.', cost: { credits: 200, alloy: 120, crystal: 10 }, buildTime: 18, place: 'owned', produce: () => ({ energy: -2 }), light: 36, hp: 1800 },
  { kind: 'shield', name: 'Aegis Pylon', role: 'Defense', desc: 'Projects a protective barrier dome.', cost: { credits: 260, alloy: 100, crystal: 30 }, buildTime: 22, place: 'owned', produce: () => ({ energy: -3 }), light: 54, hp: 2200 },
  { kind: 'relay', name: 'Claim Relay', role: 'Expansion', desc: 'Built on the frontier. Extends your territory.', cost: { credits: 300, alloy: 150 }, buildTime: 25, place: 'frontier', produce: () => ({ energy: -1 }), claim: 2, light: 44, hp: 1600 },
  { kind: 'dronebay', name: 'Drone Bay', role: 'Logistics', desc: 'Launches haulers between your structures.', cost: { credits: 220, alloy: 140 }, buildTime: 18, place: 'owned', produce: () => ({ credits: 2, energy: -2 }), light: 46, hp: 1300 },
  { kind: 'depot', name: 'Fuel Depot', role: 'Logistics', desc: 'Refuels your ships while they hover nearby.', cost: { credits: 140, alloy: 60 }, buildTime: 12, place: 'owned', produce: () => ({ energy: -1 }), light: 42, hp: 800 },
  { kind: 'repair', name: 'Repair Bay', role: 'Logistics', desc: 'Welding drones patch up your ships while they hover nearby.', cost: { credits: 160, alloy: 90 }, buildTime: 14, place: 'owned', produce: () => ({ energy: -2 }), light: 44, hp: 1000 },
  { kind: 'storage', name: 'Storage Bay', role: 'Logistics', desc: 'A huge, immovable hold. Ships nearby can load and unload cargo.', cost: { credits: 180, alloy: 120 }, buildTime: 15, place: 'owned', produce: () => ({ energy: -1 }), light: 40, hp: 2000 },
  { kind: 'hangar', name: 'Hangar', role: 'Logistics', desc: 'Stations your ships for swapping and refitting, with a large item bay. Dock nearby to use it.', cost: { credits: 260, alloy: 160 }, buildTime: 20, place: 'owned', produce: () => ({ energy: -2 }), light: 52, hp: 3000 },
  { kind: 'mechbay', name: 'Mech Bay', role: 'Military', desc: 'Builds assault mechs. Deploy one, then pick an enemy structure for it to march on and destroy.', cost: { credits: 200, alloy: 120 }, buildTime: 16, place: 'owned', produce: () => ({ energy: -2 }), light: 46, hp: 1600 },
];
export const STRUCT = Object.fromEntries(STRUCTURES.map((s) => [s.kind, s])) as Record<StructureKind, StructureDef>;
export const BUILDABLE = STRUCTURES.filter((s) => s.place !== 'none');

export interface Faction {
  id: number;
  name: string;
  tag: string;
  color: string;
  rgb: RGB;
}
const f = (id: number, name: string, tag: string, color: string): Faction => ({ id, name, tag, color, rgb: hex(color) });
export const FACTIONS: Faction[] = [
  f(0, 'DootLord Inc', 'HLC', '#49e0ff'),
  f(1, 'Vanguard Syndicate', 'VGS', '#ffb547'),
  f(2, 'Crimson Accord', 'CRA', '#ff4f6a'),
  f(3, 'Verdant Collective', 'VDC', '#5cff9d'),
  f(4, 'Umbral Reach', 'UMB', '#b48cff'),
  f(5, 'Solace Union', 'SOL', '#ffe76b'),
  f(6, 'Ashen Covenant', 'ASH', '#ff7f3f'),
  f(7, 'Tidewater Compact', 'TDW', '#3dffd2'),
  f(8, 'Nova Dominion', 'NOV', '#ff6bd5'),
  f(9, 'Iron Meridian', 'IRM', '#a9bdd6'),
];
export const PLAYER = 0;
