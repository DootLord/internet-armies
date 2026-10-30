import { cargo, fleet, hud } from '../game/game';
import { usedCells } from '../game/ships/cargo';
import { gridOf } from './CargoHold';
import { useStore } from '../game/store';

function Gauge({ label, value, max, kind }: { label: string; value: number; max: number; kind: 'hp' | 'fuel' | 'cargo' }) {
  const pct = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <div className="budget">
      <span className="muted">{label}</span>
      <div className="budget-bar f-inset">
        <div className={`budget-fill ${kind} ${kind !== 'cargo' && pct < 0.25 ? 'low' : ''}`} style={{ width: `${pct * 100}%` }} />
      </div>
      <span className="num">
        {Math.ceil(value)} / {max.toFixed(0)}
      </span>
    </div>
  );
}

/** The flagship's health and fuel, top-left under the resource bar. */
export function ShipStatus() {
  const s = useStore(hud, (h) => h.ship);
  const flying = useStore(fleet, (f) => f.flying);
  useStore(fleet, (f) => f.ships); // a refit can resize the hold
  const items = useStore(cargo, (c) => c.holds[flying]) ?? [];
  if (!s.maxHp) return null;
  const g = gridOf({ ship: flying });
  const note = s.wrecked ? <span className="bad">Destroyed: respawning at home</span>
    : s.repairing && s.refuelling ? <span className="ok">Repairing and refuelling</span>
    : s.repairing ? <span className="ok">Repairing</span>
    : s.refuelling ? <span className="ok">Refuelling</span>
    : s.fuel <= 0 ? <span className="bad">Out of fuel: thrusters only</span>
    : null;
  return (
    <section className="shipstat f-tip">
      <Gauge label="Health" value={s.hp} max={s.maxHp} kind="hp" />
      <Gauge label="Fuel" value={s.fuel} max={s.maxFuel} kind="fuel" />
      <Gauge label="Cargo" value={usedCells(items, g)} max={g.w * g.h} kind="cargo" />
      {note && <div className="shipstat-note">{note}</div>}
    </section>
  );
}
