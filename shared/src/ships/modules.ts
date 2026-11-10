// Fittable modules. High slots: weapons and interactables (mining, salvage).
// Mid: tools and utility. Low: passive upgrades. Effects are either flat
// additions or multipliers on ship attributes (see fitting.ts for stacking).
import type { AttrKey, Slot } from './hulls';

export type ModuleIconId = 'gun' | 'missile' | 'mining' | 'salvage' | 'shield' | 'thrust' | 'sensor' | 'tractor' | 'plate' | 'chip' | 'crate' | 'amp';

export interface Effect {
  attr: AttrKey;
  add?: number;
  mul?: number;
}

export interface ModuleDef {
  id: string;
  name: string;
  slot: Slot;
  icon: ModuleIconId;
  cpu: number;
  power: number;
  desc: string;
  effects: Effect[];
  /** Weapons/beams: engagement range in world px. The ship's range is its longest. */
  range?: number;
}

const m = (d: ModuleDef) => d;

export const MODULES: ModuleDef[] = [
  // ---- High: weapons and interactables
  m({ id: 'pulse-laser', name: 'Pulse Laser', slot: 'high', icon: 'gun', cpu: 18, power: 22, range: 300, desc: 'Short-range energy weapon. No ammunition.', effects: [{ attr: 'dps', add: 24 }] }),
  m({ id: 'rail-driver', name: 'Rail Driver', slot: 'high', icon: 'gun', cpu: 26, power: 42, range: 650, desc: 'Long-range kinetic slug thrower.', effects: [{ attr: 'dps', add: 17 }] }),
  m({ id: 'missile-pod', name: 'Missile Pod', slot: 'high', icon: 'missile', cpu: 32, power: 12, range: 520, desc: 'Guided ordnance. Light on the power grid, heavy on CPU.', effects: [{ attr: 'dps', add: 20 }] }),
  m({ id: 'siege-lance', name: 'Siege Lance', slot: 'high', icon: 'gun', cpu: 42, power: 190, range: 420, desc: 'Capital-grade beam. Only heavy hulls can power it.', effects: [{ attr: 'dps', add: 72 }] }),
  m({ id: 'mining-beam', name: 'Mining Beam', slot: 'high', icon: 'mining', cpu: 24, power: 8, range: 180, desc: 'Cuts materials straight from deposit tiles into your hold.', effects: [{ attr: 'mining', add: 12 }] }),
  m({ id: 'salvage-arm', name: 'Salvage Arm', slot: 'high', icon: 'salvage', cpu: 20, power: 5, range: 120, desc: 'Strips wrecks and derelict plates for parts.', effects: [] }),

  // ---- Mid: tools and utility
  m({ id: 'shield-ext', name: 'Shield Extender', slot: 'mid', icon: 'shield', cpu: 26, power: 22, desc: 'More shield capacity.', effects: [{ attr: 'shield', add: 650 }] }),
  m({ id: 'afterburner', name: 'Afterburner', slot: 'mid', icon: 'thrust', cpu: 16, power: 24, desc: 'Raises top speed and acceleration.', effects: [{ attr: 'maxSpeed', mul: 1.3 }, { attr: 'accel', mul: 1.2 }] }),
  m({ id: 'sensor-array', name: 'Sensor Array', slot: 'mid', icon: 'sensor', cpu: 22, power: 2, desc: 'Extends the reach of every weapon and beam.', effects: [{ attr: 'range', mul: 1.25 }] }),
  m({ id: 'tractor', name: 'Tractor Beam', slot: 'mid', icon: 'tractor', cpu: 22, power: 6, desc: 'Pulls cargo and wrecks toward the ship.', effects: [] }),
  m({ id: 'survey', name: 'Survey Scanner', slot: 'mid', icon: 'sensor', cpu: 18, power: 1, desc: 'Reveals deposit yields on nearby tiles.', effects: [] }),

  // ---- Low: passive upgrades
  m({ id: 'armor-plate', name: 'Armor Plating', slot: 'low', icon: 'plate', cpu: 1, power: 34, desc: 'Heavy plating. Slows the ship.', effects: [{ attr: 'armor', add: 900 }, { attr: 'maxSpeed', mul: 0.93 }, { attr: 'accel', mul: 0.9 }] }),
  m({ id: 'overdrive', name: 'Overdrive Injector', slot: 'low', icon: 'thrust', cpu: 1, power: 1, desc: 'More speed at the cost of hold space.', effects: [{ attr: 'maxSpeed', mul: 1.1 }, { attr: 'cargo', mul: 0.88 }] }),
  m({ id: 'stabilizer', name: 'Gyro Stabilizer', slot: 'low', icon: 'amp', cpu: 18, power: 1, desc: 'Better weapon tracking: more damage.', effects: [{ attr: 'dps', mul: 1.1 }] }),
  m({ id: 'inertial', name: 'Inertial Dampener', slot: 'low', icon: 'thrust', cpu: 12, power: 1, desc: 'Sharper turns.', effects: [{ attr: 'turnRate', mul: 1.15 }] }),
  m({ id: 'power-relay', name: 'Power Relay', slot: 'low', icon: 'chip', cpu: 1, power: 0, desc: 'Boosts power grid output.', effects: [{ attr: 'power', mul: 1.12 }] }),
  m({ id: 'co-processor', name: 'Co-Processor', slot: 'low', icon: 'chip', cpu: 0, power: 1, desc: 'Boosts CPU output.', effects: [{ attr: 'cpu', mul: 1.1 }] }),
  m({ id: 'hold-expander', name: 'Hold Expander', slot: 'low', icon: 'crate', cpu: 1, power: 1, desc: 'Bigger cargo hold. Slightly slower.', effects: [{ attr: 'cargo', mul: 1.25 }, { attr: 'maxSpeed', mul: 0.95 }] }),
];
export const MODULE = Object.fromEntries(MODULES.map((x) => [x.id, x])) as Record<string, ModuleDef>;
