import { useEffect, useState } from 'react';
import { PLAYER, RES_KEYS, STRUCT, StructureKind } from '../game/defs';
import { cargo, fleet, getEngine, hud, toast, world } from '../game/game';
import { CX, CY, tileX, tileY } from '../game/hex';
import { progressOf, Structure } from '../game/protocol';
import { usedCells } from '../game/ships/cargo';
import { autoSlot, canUnfit, computeStats, Fit, withModule } from '../game/ships/fitting';
import { DOCK_RANGE, ShipRecord } from '../game/ships/fleet';
import { HULL, Slot, SLOTS } from '../game/ships/hulls';
import { MODULE, MODULES } from '../game/ships/modules';
import { useStore } from '../game/store';
import { bayOf, CargoBays, gridOf } from './CargoHold';
import { ModuleIcon, ResIcon, SLOT_COLORS, UiIcon } from './icons';
import { Budget, SLOT_HINT, SLOT_NAME, SlotRows, StatsStrip } from './Loadout';
import { ShipPreview } from './ShipPreview';
import { SpriteIcon } from './SpriteIcon';
import { distanceTo, useTick } from './useReach';

type Tab = 'ships' | 'inventory' | 'base';
/** How far from a Hangar counts as "this base" for the overview, in world px. */
const BASE_RADIUS = 260;

/** Ships stationed here, plus the one you're flying while docked: pick one to fit or load. */
function ShipList({ ships, flying, sel, onSel }: { ships: ShipRecord[]; flying: number; sel: number | null; onSel: (id: number) => void }) {
  return (
    <aside className="fit-hulls">
      {ships.length === 0 && <span className="muted">No ships stationed here.</span>}
      {ships.map((s) => {
        const h = HULL[s.hull];
        return (
          <button key={s.id} className={`pbtn hull-card ${s.id === sel ? 'on' : ''}`} onClick={() => onSel(s.id)}>
            <ShipPreview hull={s.hull} maxPx={64} />
            <span className="hc-text">
              <span className="hc-name">{h.name}</span>
              <span className="muted">{h.class}</span>
              <span className="hc-slots">
                {SLOTS.map((slot) => (
                  <i key={slot} style={{ color: SLOT_COLORS[slot][0] }}>
                    {h.slots[slot]}
                  </i>
                ))}
                {s.id === flying ? <span className="hc-active">Flying</span> : <span className="muted">Stationed</span>}
              </span>
            </span>
          </button>
        );
      })}
    </aside>
  );
}

/** What this base has built and makes: buildings near the Hangar, their output, and how full its holds are. */
function BaseOverview({ hangar }: { hangar: Structure }) {
  const state = useStore(cargo, (s) => s);
  const now = world.now(), hx = tileX(hangar.col, hangar.row) + CX, hy = tileY(hangar.row) + CY;
  const near = [...world.structures.values()].filter(
    (s) => s.owner === PLAYER && Math.hypot(tileX(s.col, s.row) + CX - hx, tileY(s.row) + CY - hy) <= BASE_RADIUS,
  );
  const counts = new Map<StructureKind, number>();
  const rates: Record<string, number> = {};
  for (const s of near) {
    counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
    if (progressOf(s, now) < 1) continue;
    const p = STRUCT[s.kind].produce(world.kind(s.col, s.row) ?? 'plate');
    for (const k of RES_KEYS) rates[k] = (rates[k] ?? 0) + (p[k] ?? 0);
  }
  const holds = near.filter((s) => s.kind === 'storage' || s.kind === 'hangar');
  return (
    <div className="base-view">
      <section>
        <h3>Buildings</h3>
        <div className="base-grid">
          {[...counts].map(([kind, n]) => (
            <div key={kind} className="base-card f-inset">
              <SpriteIcon kind={kind} k={0.5} />
              <span>{STRUCT[kind].name}</span>
              <span className="num">×{n}</span>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h3>Output per cycle</h3>
        <div className="yields">
          {RES_KEYS.filter((k) => rates[k]).map((k) => (
            <span key={k} className={rates[k] > 0 ? 'up' : 'down'}>
              <ResIcon k={k} size={12} />
              {rates[k] > 0 ? '+' : ''}
              {rates[k]}
            </span>
          ))}
        </div>
      </section>
      <section>
        <h3>Holds</h3>
        {holds.map((s) => {
          const c = { store: s.id }, g = gridOf(c), used = usedCells(state.stores[s.id] ?? [], g);
          return <Budget key={s.id} label={STRUCT[s.kind].name} used={used} total={g.w * g.h} />;
        })}
      </section>
      <p className="muted">Everything within about eight hexes of this Hangar counts as its base.</p>
    </div>
  );
}

/** A Hangar: the ships stationed at a base, their fits and holds, its item bay and an overview of the base. */
export function HangarWindow() {
  const id = useStore(hud, (s) => s.hangarOpen);
  const fl = useStore(fleet, (s) => s);
  const state = useStore(cargo, (s) => s);
  const [tab, setTab] = useState<Tab>('ships');
  const [sel, setSel] = useState<number | null>(null);
  const [slotTab, setSlotTab] = useState<Slot>('high');
  const [hover, setHover] = useState<string | null>(null);
  useTick(id !== null);
  const h = id !== null ? world.structures.get(id) : undefined;
  useEffect(() => {
    if (id !== null && !h) hud.set({ hangarOpen: null }); // destroyed or demolished while open
  }, [id, h]);
  if (id === null || !h) return null;

  const dist = distanceTo(h), docked = dist <= DOCK_RANGE;
  const lock = docked ? undefined : `Fly within range to dock (${Math.round(dist)} / ${DOCK_RANGE})`;
  const here = fl.ships.filter((s) => s.station === h.id || (s.id === fl.flying && docked));
  const ship = here.find((s) => s.id === sel) ?? here.find((s) => s.id === fl.flying) ?? here[0] ?? null;
  const close = () => hud.set({ hangarOpen: null });
  const report = () => getEngine()?.shipReport();

  const body = () => {
    if (tab === 'base') return <BaseOverview hangar={h} />;
    if (tab === 'inventory')
      return (
        <div className="fit-body inv">
          <ShipList ships={here} flying={fl.flying} sel={ship?.id ?? null} onSel={setSel} />
          <CargoBays
            bays={[bayOf(state, 'bay', 'Hangar bay', { store: h.id }, lock), ...(ship ? [bayOf(state, 'ship', `${HULL[ship.hull].name} hold`, { ship: ship.id }, lock)] : [])]}
            hint="Drag items between the Hangar bay and the selected ship. The bay is lost if the Hangar is destroyed."
          />
        </div>
      );
    if (!ship) return <p className="muted">No ships stationed here. Dock with your ship to station it when you board another.</p>;

    const hull = HULL[ship.hull], fit = ship.fit, st = computeStats(ship.hull, fit);
    // Refits apply on screen at once; the shard confirms or snaps them back.
    const setFit = (f: Fit) => {
      if (lock) return toast(lock, 'bad');
      fleet.set({ ...fl, ships: fl.ships.map((s) => (s.id === ship.id ? { ...s, fit: f } : s)) });
      const r = report();
      if (r) void world.refit(ship.id, f, r).then((res) => res.ok || toast(res.reason!, 'bad'));
    };
    const placement = (mid: string) => autoSlot(ship.hull, fit, mid);
    const add = (mid: string) => {
      const p = placement(mid);
      if ('index' in p) setFit(withModule(fit, MODULE[mid].slot, p.index, mid));
      else toast(p.reason!, 'bad');
    };
    const onSlot = (slot: Slot, i: number, mid: string | null) => {
      if (!mid) return setSlotTab(slot);
      const c = canUnfit(ship.hull, fit, slot, i);
      if (c.ok) setFit(withModule(fit, slot, i, null));
      else toast(c.reason!, 'bad');
    };
    const board = () => {
      const r = report();
      if (r) void world.board(ship.id, r).then((res) => toast(res.ok ? `Now flying the ${hull.name}` : res.reason!, res.ok ? 'good' : 'bad'));
    };
    const hovered = hover ? placement(hover) : null;
    const preview = hover && hovered && 'index' in hovered ? computeStats(ship.hull, withModule(fit, MODULE[hover].slot, hovered.index, hover)) : null;
    const info = hover ? MODULE[hover] : null;

    return (
      <>
        <div className="fit-body">
          <ShipList ships={here} flying={fl.flying} sel={ship.id} onSel={setSel} />
          <main className="fit-center">
            <div className="fit-title">
              <h2>{hull.name}</h2>
              <span className="muted">
                {hull.class} · {hull.role}
              </span>
            </div>
            <div className="fit-stage f-inset">
              <ShipPreview key={ship.id} hull={ship.hull} maxPx={290} spin />
            </div>
            <SlotRows hull={ship.hull} fit={fit} focus={slotTab} onSlot={onSlot} />
            <Budget label="CPU" used={st.cpuUsed} total={st.cpu} />
            <Budget label="Power" used={st.powerUsed} total={st.power} />
            <div className="fit-actions">
              {ship.id === fl.flying ? (
                <span className="muted">You are flying this ship</span>
              ) : (
                <button className="pbtn wide" onClick={board} disabled={!docked}>
                  Board the {hull.name}
                </button>
              )}
            </div>
          </main>
          <aside className="fit-modules">
            <div className="tabs">
              {SLOTS.map((s) => (
                <button key={s} className={`pbtn tab ${slotTab === s ? 'on' : ''}`} onClick={() => setSlotTab(s)}>
                  <span style={{ color: SLOT_COLORS[s][0] }}>{SLOT_NAME[s]}</span>
                </button>
              ))}
            </div>
            <div className="muted tab-hint">{SLOT_HINT[slotTab]}</div>
            <ul className="mod-list">
              {MODULES.filter((m) => m.slot === slotTab).map((m) => {
                const ok = docked && 'index' in placement(m.id);
                return (
                  <li key={m.id}>
                    <button className={`mod-row ${ok ? '' : 'blocked'}`} onClick={() => add(m.id)} onPointerEnter={() => setHover(m.id)} onPointerLeave={() => setHover(null)}>
                      <ModuleIcon id={m.id} size={14} />
                      <span className="mod-name">{m.name}</span>
                      <span className="mod-cost num">
                        {m.cpu}
                        <small>c</small> {m.power}
                        <small>p</small>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="mod-info f-inset">
              {info ? (
                <>
                  <b>{info.name}</b>
                  <span>{info.desc}</span>
                  <span className="muted">
                    CPU {info.cpu} · Power {info.power}
                    {info.range ? ` · Range ${info.range}` : ''}
                  </span>
                  {hovered && !('index' in hovered) && <span className="bad">{hovered.reason}</span>}
                </>
              ) : (
                <span className="muted">{lock ?? 'Click a module to fit it. Click a fitted module to remove it. Hover to preview its effect.'}</span>
              )}
            </div>
          </aside>
        </div>
        <StatsStrip st={st} preview={preview} />
      </>
    );
  };

  return (
    <div className="fit-backdrop" onPointerDown={close}>
      <section className="fitting f-panel" onPointerDown={(e) => e.stopPropagation()}>
        <header className="fit-head">
          <b>Hangar</b>
          <span className={docked ? 'muted' : 'warn'}>
            {h.col}, {h.row} · {docked ? 'Docked' : lock}
          </span>
          <div className="tabs">
            {(['ships', 'inventory', 'base'] as Tab[]).map((t) => (
              <button key={t} className={`pbtn tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
                <span>{t === 'ships' ? 'Ships' : t === 'inventory' ? 'Inventory' : 'Base'}</span>
              </button>
            ))}
          </div>
          <button className="pbtn icon" onClick={close} title="Close (Esc)">
            <UiIcon name="close" />
          </button>
        </header>
        {body()}
      </section>
    </div>
  );
}
