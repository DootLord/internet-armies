import { useState } from 'react';
import { hud, toast } from '../game/game';
import { autoSlot, canUnfit, computeStats, ShipStats, withModule } from '../game/ships/fitting';
import { hangar } from '../game/ships/hangar';
import { HULL, HULLS, HullId, Slot, SLOTS } from '../game/ships/hulls';
import { MODULE, MODULES } from '../game/ships/modules';
import { useStore } from '../game/store';
import { ModuleIcon, SLOT_COLORS, UiIcon } from './icons';
import { HangarHold } from './CargoHold';
import { ShipPreview } from './ShipPreview';

const SLOT_NAME: Record<Slot, string> = { high: 'High', mid: 'Mid', low: 'Low' };
const SLOT_HINT: Record<Slot, string> = { high: 'Weapons & beams', mid: 'Tools & utility', low: 'Upgrades' };

const STAT_ROWS: { key: keyof ShipStats; label: string; fmt: (v: number) => string }[] = [
  { key: 'maxSpeed', label: 'Speed', fmt: (v) => v.toFixed(0) },
  { key: 'turnRate', label: 'Agility', fmt: (v) => `${((v * 180) / Math.PI).toFixed(0)}°/s` },
  { key: 'shield', label: 'Shield', fmt: (v) => v.toFixed(0) },
  { key: 'armor', label: 'Armor', fmt: (v) => v.toFixed(0) },
  { key: 'hull', label: 'Hull', fmt: (v) => v.toFixed(0) },
  { key: 'dps', label: 'DPS', fmt: (v) => v.toFixed(0) },
  { key: 'range', label: 'Range', fmt: (v) => v.toFixed(0) },
  { key: 'mining', label: 'Mining', fmt: (v) => `${v.toFixed(0)}/s` },
  { key: 'cargo', label: 'Cargo', fmt: (v) => v.toFixed(0) },
  { key: 'fuel', label: 'Fuel', fmt: (v) => v.toFixed(0) },
];

function Budget({ label, used, total }: { label: string; used: number; total: number }) {
  const pct = total > 0 ? used / total : 0;
  return (
    <div className="budget">
      <span className="muted">{label}</span>
      <div className="budget-bar f-inset">
        <div className={`budget-fill ${pct > 0.9 ? 'hot' : ''}`} style={{ width: `${Math.min(1, pct) * 100}%` }} />
      </div>
      <span className="num">
        {used.toFixed(0)} / {total.toFixed(0)}
      </span>
    </div>
  );
}

export function Fitting() {
  const open = useStore(hud, (s) => s.fittingOpen);
  const hg = useStore(hangar, (s) => s);
  const [viewHull, setViewHull] = useState<HullId>(hg.active);
  const [tab, setTab] = useState<Slot | 'cargo'>('high');
  const [hover, setHover] = useState<string | null>(null);
  if (!open) return null;

  const hull = HULL[viewHull];
  const fit = hg.fits[viewHull];
  const st = computeStats(viewHull, fit);
  const setFit = (f: typeof fit) => hangar.set({ fits: { ...hg.fits, [viewHull]: f } });
  const close = () => hud.set({ fittingOpen: false });

  const placement = (id: string) => autoSlot(viewHull, fit, id);
  const add = (id: string) => {
    const r = placement(id);
    if ('index' in r) setFit(withModule(fit, MODULE[id].slot, r.index, id));
    else toast(r.reason!, 'bad');
  };
  const remove = (slot: Slot, i: number) => {
    const c = canUnfit(viewHull, fit, slot, i);
    if (c.ok) setFit(withModule(fit, slot, i, null));
    else toast(c.reason!, 'bad');
  };

  // Hovering a module previews the fit with it in place, so stats show deltas.
  const hovered = hover ? placement(hover) : null;
  const preview = hover && hovered && 'index' in hovered ? computeStats(viewHull, withModule(fit, MODULE[hover].slot, hovered.index, hover)) : null;
  const info = hover ? MODULE[hover] : null;

  return (
    <div className="fit-backdrop" onPointerDown={close}>
      <section className="fitting f-panel" onPointerDown={(e) => e.stopPropagation()}>
        <header className="fit-head">
          <b>Hangar</b>
          <span className="muted">Command Nexus · {HULLS.length} hulls</span>
          <button className="pbtn icon" onClick={close} title="Close (G / Esc)">
            <UiIcon name="close" />
          </button>
        </header>

        <div className="fit-body">
          <aside className="fit-hulls">
            {HULLS.map((h) => (
              <button key={h.id} className={`pbtn hull-card ${h.id === viewHull ? 'on' : ''}`} onClick={() => setViewHull(h.id)}>
                <ShipPreview hull={h.id} maxPx={64} />
                <span className="hc-text">
                  <span className="hc-name">{h.name}</span>
                  <span className="muted">{h.class}</span>
                  <span className="hc-slots">
                    {SLOTS.map((s) => (
                      <i key={s} style={{ color: SLOT_COLORS[s][0] }}>
                        {h.slots[s]}
                      </i>
                    ))}
                    {hg.active === h.id && <span className="hc-active">Flying</span>}
                  </span>
                </span>
              </button>
            ))}
          </aside>

          <main className="fit-center">
            <div className="fit-title">
              <h2>{hull.name}</h2>
              <span className="muted">
                {hull.class} · {hull.role}
              </span>
            </div>
            <div className="fit-stage f-inset">
              <ShipPreview key={viewHull} hull={viewHull} maxPx={290} spin />
            </div>
            <div className="slot-rows">
              {SLOTS.map((slot) => (
                <div key={slot} className="slot-row">
                  <span className="slot-label" style={{ color: SLOT_COLORS[slot][0] }}>
                    {SLOT_NAME[slot]}
                  </span>
                  {fit[slot].map((id, i) => (
                    <button
                      key={i}
                      className={`slot f-inset ${id ? 'filled' : ''} ${!id && tab === slot ? 'focus' : ''}`}
                      style={{ ['--slot' as string]: SLOT_COLORS[slot][0] }}
                      onClick={() => (id ? remove(slot, i) : setTab(slot))}
                      title={id ? `${MODULE[id].name}: click to remove` : `Empty ${SLOT_NAME[slot].toLowerCase()} slot`}
                    >
                      {id && <ModuleIcon id={id} />}
                    </button>
                  ))}
                </div>
              ))}
            </div>
            <Budget label="CPU" used={st.cpuUsed} total={st.cpu} />
            <Budget label="Power" used={st.powerUsed} total={st.power} />
            <div className="fit-actions">
              {hg.active === viewHull ? (
                <span className="muted">You are flying this hull</span>
              ) : (
                <button className="pbtn wide" onClick={() => hangar.set({ active: viewHull })}>
                  Board the {hull.name}
                </button>
              )}
            </div>
          </main>

          <aside className="fit-modules">
            <div className="tabs">
              {SLOTS.map((s) => (
                <button key={s} className={`pbtn tab ${tab === s ? 'on' : ''}`} onClick={() => setTab(s)}>
                  <span style={{ color: SLOT_COLORS[s][0] }}>{SLOT_NAME[s]}</span>
                </button>
              ))}
              <button className={`pbtn tab ${tab === 'cargo' ? 'on' : ''}`} onClick={() => setTab('cargo')}>
                <span>Cargo</span>
              </button>
            </div>
            {tab === 'cargo' ? (
              <HangarHold hull={viewHull} fit={fit} />
            ) : (
            <>
            <div className="muted tab-hint">{SLOT_HINT[tab]}</div>
            <ul className="mod-list">
              {MODULES.filter((m) => m.slot === tab).map((m) => {
                const r = placement(m.id);
                const ok = 'index' in r;
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
                <span className="muted">Click a module to fit it. Click a fitted module to remove it. Hover to preview its effect.</span>
              )}
            </div>
            </>
            )}
          </aside>
        </div>

        <footer className="fit-stats">
          {STAT_ROWS.map(({ key, label, fmt }) => {
            const v = st[key], p = preview?.[key];
            const d = p !== undefined ? p - v : 0;
            return (
              <div key={key} className="stat-cell">
                <span className="muted">{label}</span>
                <span className="num">{fmt(v)}</span>
                {Math.abs(d) > 0.01 && <span className={`num delta ${d > 0 ? 'up' : 'down'}`}>{d > 0 ? '+' : ''}{key === 'turnRate' ? `${((d * 180) / Math.PI).toFixed(0)}` : d.toFixed(0)}</span>}
              </div>
            );
          })}
        </footer>
      </section>
    </div>
  );
}
