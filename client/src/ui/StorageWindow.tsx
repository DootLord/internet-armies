import { useEffect } from 'react';
import { cargo, fleet, flyingShip, hud, world } from '../game/game';
import { STORAGE_RANGE } from '../game/ships/cargo';
import { HULL } from '../game/ships/hulls';
import { useStore } from '../game/store';
import { bayOf, CargoBays } from './CargoHold';
import { UiIcon } from './icons';
import { distanceTo, useTick } from './useReach';

/** A Storage Bay's contents beside the flagship's hold. Transfers need the ship parked nearby. */
export function StorageWindow() {
  const id = useStore(hud, (s) => s.storageOpen);
  const state = useStore(cargo, (s) => s);
  const me = flyingShip(useStore(fleet, (f) => f));
  // The ship moves every frame; re-check the range a few times a second.
  useTick(id !== null);
  const s = id !== null ? world.structures.get(id) : undefined;
  useEffect(() => {
    if (id !== null && !s) hud.set({ storageOpen: null }); // destroyed or demolished while open
  }, [id, s]);
  if (id === null || !s || !me) return null;

  const close = () => hud.set({ storageOpen: null });
  const d = distanceTo(s);
  const locked = d > STORAGE_RANGE ? `Fly within range to load (${Math.round(d)} / ${STORAGE_RANGE})` : undefined;
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
        bays={[bayOf(state, 'store', 'Storage', { store: s.id }, locked), bayOf(state, 'ship', `${HULL[me.hull].name} hold`, { ship: me.id })]}
        hint="Drag items between the Storage and your ship. The Storage never moves, and everything in it is lost if it's destroyed."
      />
    </section>
  );
}
