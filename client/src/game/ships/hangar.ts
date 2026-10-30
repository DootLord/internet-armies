// The player's hangar: which hull they're flying and a saved fit per hull.
// Kept in localStorage for this prototype; it belongs on the server (empire
// service) once accounts exist, validated with the same fitting.ts rules.
import { createStore } from '../store';
import { autoSlot, emptyFit, Fit, withModule } from './fitting';
import { HULLS, HullId } from './hulls';
import { MODULE } from './modules';

export interface Hangar {
  active: HullId;
  fits: Record<HullId, Fit>;
}

const KEY = 'ia.hangar.v1';

/** Starter loadouts so every hull flies sensibly out of the box. */
export const STARTERS: Record<HullId, string[]> = {
  wisp: ['pulse-laser', 'afterburner', 'shield-ext', 'inertial'],
  lancer: ['pulse-laser', 'pulse-laser', 'mining-beam', 'shield-ext', 'afterburner', 'armor-plate', 'stabilizer'],
  bastion: ['siege-lance', 'rail-driver', 'rail-driver', 'shield-ext', 'sensor-array', 'armor-plate', 'armor-plate', 'power-relay'],
  mule: ['mining-beam', 'shield-ext', 'tractor', 'hold-expander', 'hold-expander', 'armor-plate'],
};

export function starterFit(hull: HullId): Fit {
  let fit = emptyFit(hull);
  for (const id of STARTERS[hull]) {
    const r = autoSlot(hull, fit, id);
    if ('index' in r) fit = withModule(fit, MODULE[id].slot, r.index, id);
  }
  return fit;
}

function load(): Hangar {
  const fallback: Hangar = { active: 'lancer', fits: Object.fromEntries(HULLS.map((h) => [h.id, starterFit(h.id)])) as Record<HullId, Fit> };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as Hangar;
    // Keep saved fits only if they still match the hull's slot layout.
    for (const h of HULLS) {
      const f = saved.fits?.[h.id];
      if (f && (['high', 'mid', 'low'] as const).every((s) => f[s]?.length === h.slots[s])) fallback.fits[h.id] = f;
    }
    if (HULLS.some((h) => h.id === saved.active)) fallback.active = saved.active;
    return fallback;
  } catch {
    return fallback;
  }
}

export const hangar = createStore<Hangar>(load());
hangar.subscribe(() => {
  try {
    localStorage.setItem(KEY, JSON.stringify(hangar.get()));
  } catch {
    // Private mode / storage disabled: the hangar just won't persist.
  }
});
