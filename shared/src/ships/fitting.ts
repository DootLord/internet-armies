// Fitting rules and final ship stats. Pure functions: the server can validate
// fits with exactly this code, and the UI uses it for live feedback.
import { FLIGHT, FlightParams } from './flight';
import { AttrKey, HULL, HullId, ShipAttrs, Slot, SLOTS } from './hulls';
import { MODULE } from './modules';

export type Fit = Record<Slot, (string | null)[]>;

export interface ShipStats extends ShipAttrs {
  cpuUsed: number;
  powerUsed: number;
}

export interface FitCheck {
  ok: boolean;
  reason?: string;
}

export const emptyFit = (hull: HullId): Fit => {
  const s = HULL[hull].slots;
  return { high: Array(s.high).fill(null), mid: Array(s.mid).fill(null), low: Array(s.low).fill(null) };
};

/**
 * Diminishing returns for repeated multipliers on the same attribute: the
 * strongest applies fully, the next at 87%, then 57%, 28%, 11%. Stops five
 * identical upgrades from being five times as good.
 */
export const STACKING = [1, 0.869, 0.571, 0.283, 0.106, 0.03];

export function fittedModules(fit: Fit) {
  return SLOTS.flatMap((s) => fit[s]).filter((id): id is string => !!id).map((id) => MODULE[id]);
}

export function computeStats(hull: HullId, fit: Fit): ShipStats {
  const out = { ...HULL[hull].base, cpuUsed: 0, powerUsed: 0 } as ShipStats;
  const mods = fittedModules(fit);
  const mults = new Map<AttrKey, number[]>();
  for (const mod of mods) {
    out.cpuUsed += mod.cpu;
    out.powerUsed += mod.power;
    if (mod.range) out.range = Math.max(out.range, mod.range);
    for (const e of mod.effects) {
      if (e.add) out[e.attr] += e.add;
      if (e.mul) (mults.get(e.attr) ?? mults.set(e.attr, []).get(e.attr)!).push(e.mul);
    }
  }
  for (const [attr, list] of mults) {
    // Bonuses and penalties stack separately, each strongest-first.
    const bonuses = list.filter((v) => v >= 1).sort((a, b) => b - a);
    const maluses = list.filter((v) => v < 1).sort((a, b) => a - b);
    for (const group of [bonuses, maluses]) group.forEach((v, i) => (out[attr] *= 1 + (v - 1) * (STACKING[i] ?? 0)));
  }
  return out;
}

/** Can `moduleId` go into `slot[index]`? Checks slot type, availability, CPU and power. */
export function canFit(hull: HullId, fit: Fit, slot: Slot, index: number, moduleId: string): FitCheck {
  const mod = MODULE[moduleId];
  if (!mod) return { ok: false, reason: 'Unknown module' };
  if (mod.slot !== slot) return { ok: false, reason: `Needs a ${mod.slot} slot` };
  if (index < 0 || index >= HULL[hull].slots[slot]) return { ok: false, reason: `No ${slot} slot ${index + 1}` };
  if (fit[slot][index]) return { ok: false, reason: 'Slot occupied' };
  const next = withModule(fit, slot, index, moduleId);
  const st = computeStats(hull, next);
  // Budgets are checked against the *new* outputs, so a Co-Processor can make room for itself.
  if (st.cpuUsed > st.cpu + 1e-9) return { ok: false, reason: `Needs ${mod.cpu} CPU, ${Math.max(0, Math.floor(st.cpu - (st.cpuUsed - mod.cpu)))} free` };
  if (st.powerUsed > st.power + 1e-9) return { ok: false, reason: `Needs ${mod.power} power, ${Math.max(0, Math.floor(st.power - (st.powerUsed - mod.power)))} free` };
  return { ok: true };
}

export function withModule(fit: Fit, slot: Slot, index: number, moduleId: string | null): Fit {
  const next: Fit = { high: [...fit.high], mid: [...fit.mid], low: [...fit.low] };
  next[slot][index] = moduleId;
  return next;
}

/** First free slot of the module's type that it can legally go into, or the reason none can. */
export function autoSlot(hull: HullId, fit: Fit, moduleId: string): { index: number } | FitCheck {
  const slot = MODULE[moduleId].slot;
  const free = fit[slot].findIndex((x) => !x);
  if (free < 0) return { ok: false, reason: `All ${slot} slots are full` };
  const c = canFit(hull, fit, slot, free, moduleId);
  return c.ok ? { index: free } : c;
}

/**
 * Removing a module can break a fit (e.g. pulling a Power Relay that others
 * depend on). Returns the reason if the result would be over budget.
 */
export function canUnfit(hull: HullId, fit: Fit, slot: Slot, index: number): FitCheck {
  const st = computeStats(hull, withModule(fit, slot, index, null));
  if (st.cpuUsed > st.cpu + 1e-9) return { ok: false, reason: 'Other modules need the CPU this provides' };
  if (st.powerUsed > st.power + 1e-9) return { ok: false, reason: 'Other modules need the power this provides' };
  return { ok: true };
}

/** Flight handling derived from fitted stats. */
export function flightParams(st: ShipStats): FlightParams {
  return {
    ...FLIGHT,
    maxSpeed: st.maxSpeed,
    boostSpeed: st.maxSpeed * 1.8,
    accel: st.accel,
    boostAccel: st.accel * 1.75,
    reverseSpeed: st.maxSpeed * 0.3,
    turnRate: st.turnRate,
    turnAccel: st.turnRate * 3.3,
  };
}

/**
 * Damage and reach of one weapon type in a fit: every other high-slot module is
 * set aside, so only that weapon's damage counts, while low and mid upgrades
 * (stabilizers, sensor arrays) still apply their multipliers.
 */
export function weaponStats(hull: HullId, fit: Fit, moduleId: string) {
  const only: Fit = { ...fit, high: fit.high.map((id) => (id === moduleId ? id : null)) };
  const count = only.high.filter(Boolean).length;
  const st = computeStats(hull, only);
  return { count, dps: count ? st.dps : 0, range: count ? st.range : 0 };
}
