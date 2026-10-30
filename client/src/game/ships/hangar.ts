// Starter loadouts. The fleet itself (which ships exist, their fits, where
// they're stationed) belongs to the shard; see fleet.ts and sim/LocalShard.ts.
import { autoSlot, emptyFit, Fit, withModule } from './fitting';
import { HullId } from './hulls';
import { MODULE } from './modules';

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
