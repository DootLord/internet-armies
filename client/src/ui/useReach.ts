import { useEffect, useState } from 'react';
import { PLAYER } from '../game/defs';
import { getEngine, world } from '../game/game';
import { CX, CY, tileX, tileY } from '../game/hex';
import { progressOf, Structure } from '../game/protocol';
import { DOCK_RANGE } from '../game/ships/fleet';

/** Re-render a few times a second while mounted: the flagship moves every frame. */
export function useTick(on = true) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [on]);
}

/** Ground distance from the flagship to a structure (the same measure the shard checks). */
export function distanceTo(s: Structure) {
  const ship = getEngine()?.shipReport();
  return ship ? Math.hypot(tileX(s.col, s.row) + CX - ship.x, tileY(s.row) + CY - ship.y) : Infinity;
}

/** The player's finished Hangar the flagship is docked at, if any. */
export function dockedHangar(): Structure | null {
  const now = world.now();
  let best: Structure | null = null, bd = DOCK_RANGE;
  for (const s of world.structures.values()) {
    if (s.kind !== 'hangar' || s.owner !== PLAYER || progressOf(s, now) < 1) continue;
    const d = distanceTo(s);
    if (d <= bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}
