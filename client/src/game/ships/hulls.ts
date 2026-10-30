// Hull definitions: what each ship *is* before fitting. Base attributes feed
// fitting.ts, which applies modules and produces the final ship stats.
import { FACTIONS } from '../defs';
import { ShapeId, shipModel } from './shapes';
import { ShipSprites } from './voxel';

export type Slot = 'high' | 'mid' | 'low';
export const SLOTS: Slot[] = ['high', 'mid', 'low'];

/** Every attribute modules can modify. */
export interface ShipAttrs {
  cpu: number;
  power: number;
  maxSpeed: number;
  accel: number;
  turnRate: number;
  shield: number;
  armor: number;
  hull: number;
  cargo: number;
  dps: number;
  range: number;
  mining: number;
}
export type AttrKey = keyof ShipAttrs;

export interface HullDef {
  id: ShapeId;
  name: string;
  class: string;
  role: string;
  slots: Record<Slot, number>;
  base: ShipAttrs;
  /** Hover height (bigger hulls ride higher) and shadow radius, in art px. */
  alt: number;
  shadow: number;
}

const attrs = (a: Partial<ShipAttrs>): ShipAttrs => ({
  cpu: 0, power: 0, maxSpeed: 0, accel: 0, turnRate: 0, shield: 0, armor: 0, hull: 0, cargo: 0, dps: 0, range: 0, mining: 0, ...a,
});

export const HULLS: HullDef[] = [
  {
    id: 'wisp', name: 'Wisp', class: 'Interceptor', role: 'Scouting, pursuit and frontier claims. Fragile and very fast.',
    slots: { high: 2, mid: 3, low: 2 },
    base: attrs({ cpu: 120, power: 75, maxSpeed: 230, accel: 430, turnRate: 3.6, shield: 420, armor: 280, hull: 300, cargo: 60 }),
    alt: 14, shadow: 10,
  },
  {
    id: 'lancer', name: 'Lancer', class: 'Strike Cruiser', role: 'Balanced command ship. Fits almost anything, masters nothing.',
    slots: { high: 4, mid: 3, low: 3 },
    base: attrs({ cpu: 230, power: 230, maxSpeed: 150, accel: 240, turnRate: 2.7, shield: 1400, armor: 1200, hull: 1000, cargo: 320 }),
    alt: 16, shadow: 15,
  },
  {
    id: 'bastion', name: 'Bastion', class: 'Heavy Gunship', role: 'Slow, armoured gun platform for holding territory.',
    slots: { high: 5, mid: 3, low: 5 },
    base: attrs({ cpu: 300, power: 950, maxSpeed: 92, accel: 110, turnRate: 1.4, shield: 3000, armor: 4200, hull: 3200, cargo: 450 }),
    alt: 22, shadow: 22,
  },
  {
    id: 'mule', name: 'Mule', class: 'Hauler', role: 'Moves materials between sectors. Huge hold, barely armed.',
    slots: { high: 1, mid: 3, low: 4 },
    base: attrs({ cpu: 150, power: 95, maxSpeed: 112, accel: 140, turnRate: 1.8, shield: 900, armor: 700, hull: 1800, cargo: 6000 }),
    alt: 18, shadow: 18,
  },
];
export const HULL = Object.fromEntries(HULLS.map((h) => [h.id, h])) as Record<ShapeId, HullDef>;
export type HullId = ShapeId;

const sprites = new Map<string, ShipSprites>();
/** Shared, lazily-rendered sprite cache per hull and faction (engine + UI previews). */
export function hullSprites(id: HullId, faction = 0) {
  const key = `${id}:${faction}`;
  let s = sprites.get(key);
  if (!s) sprites.set(key, (s = new ShipSprites(shipModel(id), FACTIONS[faction].rgb)));
  return s;
}
