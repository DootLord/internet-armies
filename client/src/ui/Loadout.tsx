// Pieces shared by the ship panel (read-only) and the Hangar (editable):
// slot rows, CPU/power budgets and the stats strip.
import { Fit, ShipStats } from '../game/ships/fitting';
import { HullId, Slot, SLOTS } from '../game/ships/hulls';
import { MODULE } from '../game/ships/modules';
import { ModuleIcon, SLOT_COLORS } from './icons';

export const SLOT_NAME: Record<Slot, string> = { high: 'High', mid: 'Mid', low: 'Low' };
export const SLOT_HINT: Record<Slot, string> = { high: 'Weapons & beams', mid: 'Tools & utility', low: 'Upgrades' };

export const STAT_ROWS: { key: keyof ShipStats; label: string; fmt: (v: number) => string }[] = [
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

export function Budget({ label, used, total }: { label: string; used: number; total: number }) {
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

/** High/mid/low slot rows. Without `onSlot` they're read-only (hover still names the module). */
export function SlotRows({ fit, focus, onSlot }: { hull: HullId; fit: Fit; focus?: Slot | null; onSlot?: (slot: Slot, i: number, id: string | null) => void }) {
  return (
    <div className="slot-rows">
      {SLOTS.map((slot) => (
        <div key={slot} className="slot-row">
          <span className="slot-label" style={{ color: SLOT_COLORS[slot][0] }}>
            {SLOT_NAME[slot]}
          </span>
          {fit[slot].map((id, i) => (
            <button
              key={i}
              className={`slot f-inset ${id ? 'filled' : ''} ${!id && focus === slot ? 'focus' : ''} ${onSlot ? '' : 'static'}`}
              style={{ ['--slot' as string]: SLOT_COLORS[slot][0] }}
              onClick={() => onSlot?.(slot, i, id)}
              title={id ? `${MODULE[id].name}${onSlot ? ': click to remove' : ''}` : `Empty ${SLOT_NAME[slot].toLowerCase()} slot`}
            >
              {id && <ModuleIcon id={id} />}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** The stats strip; with `preview`, shows what would change. */
export function StatsStrip({ st, preview }: { st: ShipStats; preview?: ShipStats | null }) {
  return (
    <footer className="fit-stats">
      {STAT_ROWS.map(({ key, label, fmt }) => {
        const v = st[key], p = preview?.[key];
        const d = p !== undefined ? p - v : 0;
        return (
          <div key={key} className="stat-cell">
            <span className="muted">{label}</span>
            <span className="num">{fmt(v)}</span>
            {Math.abs(d) > 0.01 && (
              <span className={`num delta ${d > 0 ? 'up' : 'down'}`}>
                {d > 0 ? '+' : ''}
                {key === 'turnRate' ? `${((d * 180) / Math.PI).toFixed(0)}` : d.toFixed(0)}
              </span>
            )}
          </div>
        );
      })}
    </footer>
  );
}
