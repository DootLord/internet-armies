// Ship sprites per hull, colour and damage stage. Client-only: hull stats live
// in hulls.ts (shared with the server), the look lives here.
import { FACTIONS } from '@eden/shared/defs';
import type { HullId } from '@eden/shared/ships/hulls';
import { shipModel } from './shapes';
import { ShipSprites } from './voxel';

const sprites = new Map<string, ShipSprites>();
/** Shared, lazily-rendered sprite cache per hull, colour and damage stage (engine + UI previews). */
export function hullSprites(id: HullId, color = 0, stage = 0) {
  const key = `${id}:${color}:${stage}`;
  let s = sprites.get(key);
  if (!s) sprites.set(key, (s = new ShipSprites(shipModel(id, stage), FACTIONS[color].rgb)));
  return s;
}
