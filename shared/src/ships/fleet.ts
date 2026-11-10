// A player's fleet: each ship is a hull with its own fit and hold, either the
// one being flown or stationed in a Hangar. Pure rules, shared by the shard
// (which owns the fleet) and the client (which predicts and displays it).
import type { Grid } from './cargo';
import { computeStats, Fit, FitCheck } from './fitting';
import { HULL, HullId, SLOTS } from './hulls';
import { MODULE } from './modules';

export interface ShipRecord {
  id: number;
  hull: HullId;
  fit: Fit;
  /** Hangar structure id it's stationed in; null while flown; -1 when its Hangar was lost and it awaits a new one. */
  station: number | null;
}

export interface FleetState {
  ships: ShipRecord[];
  /** The ship the player is flying. */
  flying: number;
}

/** World px from a Hangar's tile centre that counts as docked. */
export const DOCK_RANGE = 100;
/** A Hangar's item bay. */
export const HANGAR_GRID: Grid = { w: 14, h: 10 };

/** A whole fit, checked from scratch: slot layout, module types and CPU/power budgets. */
export function validFit(hull: HullId, fit: Fit): FitCheck {
  for (const s of SLOTS) {
    if (fit[s]?.length !== HULL[hull].slots[s]) return { ok: false, reason: 'Slot layout mismatch' };
    for (const id of fit[s]) if (id && MODULE[id]?.slot !== s) return { ok: false, reason: 'Module in the wrong slot' };
  }
  const st = computeStats(hull, fit);
  if (st.cpuUsed > st.cpu + 1e-9) return { ok: false, reason: 'Over CPU' };
  if (st.powerUsed > st.power + 1e-9) return { ok: false, reason: 'Over power' };
  return { ok: true };
}
