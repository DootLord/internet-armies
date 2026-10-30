import { useEffect, useState } from 'react';
import { CX, CY, tileX, tileY } from '../game/hex';
import { cargo, getEngine, hud, world } from '../game/game';
import { STORAGE_GRID, STORAGE_RANGE } from '../game/ships/cargo';
import { hangar } from '../game/ships/hangar';
import { HULL } from '../game/ships/hulls';
import { useStore } from '../game/store';
import { CargoBays, gridOf } from './CargoHold';
import { UiIcon } from './icons';

/** A Storage Bay's contents beside the flagship's hold. Transfers need the ship parked nearby. */
export function StorageWindow() {
  const id = useStore(hud, (s) => s.storageOpen);
  const state = useStore(cargo, (s) => s);
  const hg = useStore(hangar, (s) => s);
  // The ship moves every frame; re-check the range a few times a second.
  const [, tick] = useState(0);
  useEffect(() => {
    if (id === null) return;
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [id]);
  const s = id !== null ? world.structures.get(id) : undefined;
  useEffect(() => {
    if (id !== null && !s) hud.set({ storageOpen: null }); // destroyed or demolished while open
  }, [id, s]);
  if (id === null || !s) return null;

  const close = () => hud.set({ storageOpen: null });
  const ship = getEngine()?.shipReport();
  const d = ship ? Math.hypot(tileX(s.col, s.row) + CX - ship.x, tileY(s.row) + CY - ship.y) : Infinity;
  const locked = d > STORAGE_RANGE ? `Fly within range to load (${Math.round(d)} / ${STORAGE_RANGE})` : undefined;
  const hold = { ship: hg.active, fit: hg.fits[hg.active] };
  return (
    <section className="storage-win f-panel">
      <header className="fit-head">
        <b>Storage Bay</b>
        <span className="muted">
          {s.col}, {s.row}
        </span>
        <button className="pbtn icon" onClick={close} title="Close (Esc)">
          <UiIcon name="close" />
        </button>
      </header>
      <CargoBays
        bays={[
          { key: 'store', label: 'Storage', container: { storage: s.id }, items: state.stores[s.id] ?? [], grid: STORAGE_GRID, locked },
          { key: 'ship', label: `${HULL[hg.active].name} hold`, container: hold, items: state.holds[hg.active] ?? [], grid: gridOf(hold) },
        ]}
        hint="Drag items between the Storage and your ship. The Storage never moves, and everything in it is lost if it's destroyed."
      />
    </section>
  );
}
