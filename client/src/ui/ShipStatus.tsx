import { hud } from '../game/game';
import { useStore } from '../game/store';

function Gauge({ label, value, max, kind }: { label: string; value: number; max: number; kind: 'hp' | 'fuel' }) {
  const pct = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <div className="budget">
      <span className="muted">{label}</span>
      <div className="budget-bar f-inset">
        <div className={`budget-fill ${kind} ${pct < 0.25 ? 'low' : ''}`} style={{ width: `${pct * 100}%` }} />
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
  if (!s.maxHp) return null;
  const note = s.wrecked ? <span className="bad">Destroyed: respawning at home</span>
    : s.refuelling ? <span className="ok">Refuelling</span>
    : s.fuel <= 0 ? <span className="bad">Out of fuel: thrusters only</span>
    : null;
  return (
    <section className="shipstat f-tip">
      <Gauge label="Health" value={s.hp} max={s.maxHp} kind="hp" />
      <Gauge label="Fuel" value={s.fuel} max={s.maxFuel} kind="fuel" />
      {note && <div className="shipstat-note">{note}</div>}
    </section>
  );
}
