import { cargo, fleet, flyingShip, hud } from '../game/game';
import { computeStats } from '../game/ships/fitting';
import { HULL } from '../game/ships/hulls';
import { useStore } from '../game/store';
import { bayOf, CargoBays } from './CargoHold';
import { UiIcon } from './icons';
import { Budget, SlotRows, StatsStrip } from './Loadout';
import { ShipPreview } from './ShipPreview';
import { dockedHangar, useTick } from './useReach';

/** G: the ship you're flying. Loadout is read-only out here; refits and swaps happen docked at a Hangar. */
export function ShipPanel() {
  const open = useStore(hud, (s) => s.shipOpen);
  const fl = useStore(fleet, (s) => s);
  const state = useStore(cargo, (s) => s);
  useTick(open);
  const me = flyingShip(fl);
  if (!open || !me) return null;

  const hull = HULL[me.hull], st = computeStats(me.hull, me.fit);
  const close = () => hud.set({ shipOpen: false });
  const dock = dockedHangar();
  return (
    <div className="fit-backdrop" onPointerDown={close}>
      <section className="fitting shippanel f-panel" onPointerDown={(e) => e.stopPropagation()}>
        <header className="fit-head">
          <b>{hull.name}</b>
          <span className="muted">
            {hull.class} · {hull.role}
          </span>
          <button className="pbtn icon" onClick={close} title="Close (G / Esc)">
            <UiIcon name="close" />
          </button>
        </header>

        <div className="ship-body">
          <main className="fit-center">
            <div className="fit-stage f-inset">
              <ShipPreview key={me.hull} hull={me.hull} maxPx={240} spin />
            </div>
            <SlotRows hull={me.hull} fit={me.fit} />
            <Budget label="CPU" used={st.cpuUsed} total={st.cpu} />
            <Budget label="Power" used={st.powerUsed} total={st.power} />
            <div className="fit-actions">
              {dock ? (
                <button className="pbtn wide" onClick={() => hud.set({ shipOpen: false, hangarOpen: dock.id })}>
                  Docked · Open Hangar
                </button>
              ) : (
                <span className="muted">Refit and change ships while docked at a Hangar.</span>
              )}
            </div>
          </main>
          <aside className="ship-cargo">
            <CargoBays bays={[bayOf(state, 'hold', 'Cargo hold', { ship: me.id })]} hint="Drag items to pack the hold. Unload at a Hangar or Storage Bay; find more by opening caches." />
          </aside>
        </div>

        <StatsStrip st={st} />
      </section>
    </div>
  );
}
