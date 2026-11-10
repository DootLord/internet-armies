// Empire ids -> names and colours. Owner ids on tiles, structures and squads
// are empire ids (any number), while the art is pre-rendered per palette
// colour, so everything that draws or labels an owner goes through here.
import { Faction, FACTIONS } from '@eden/shared/defs';
import type { EmpireInfo } from '@eden/shared/protocol';

const known = new Map<number, EmpireInfo>();

export function learnEmpires(list: EmpireInfo[]) {
  for (const e of list) known.set(e.id, e);
}

/** Palette index for an owner. Unknown ids get a stable fallback until their info arrives. */
export function colorOf(owner: number) {
  const c = known.get(owner)?.color ?? owner;
  return ((c % FACTIONS.length) + FACTIONS.length) % FACTIONS.length;
}

/** Name and colours for an owner, ready to draw with. */
export function faction(owner: number): Faction {
  const base = FACTIONS[colorOf(owner)];
  return { ...base, name: known.get(owner)?.name ?? 'Unknown empire' };
}

export function empireName(owner: number) {
  return known.get(owner)?.name ?? 'Unknown empire';
}
