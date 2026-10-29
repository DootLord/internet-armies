import { BUILDABLE, RES_KEYS } from '../game/defs';
import { getEngine, hud } from '../game/game';
import { assets } from '../game/sprites';
import { useStore } from '../game/store';
import { ResIcon } from './icons';

export function BuildDock() {
  const mode = useStore(hud, (s) => s.buildMode);
  const res = useStore(hud, (s) => s.res);
  return (
    <section className="build panel">
      <div className="ph">
        <span className="ph-title">Fabrication</span>
        <span className="ph-meta">{mode ? 'RMB / ESC TO CANCEL' : 'SHIFT-CLICK TO CHAIN'}</span>
      </div>
      <div className="build-grid">
        {BUILDABLE.map((d, i) => {
          const afford = RES_KEYS.every((k) => res[k] >= (d.cost[k] ?? 0));
          return (
            <button
              key={d.kind}
              className={`build-card ${mode === d.kind ? 'active' : ''} ${afford ? '' : 'poor'}`}
              onClick={() => getEngine()?.setBuildMode(mode === d.kind ? null : d.kind)}
              title={`${d.name} — ${d.desc}`}
            >
              <span className="hotkey">{i + 1}</span>
              <img src={assets.icons.get(d.kind)} alt="" draggable={false} />
              <span className="bc-name">{d.name}</span>
              <span className="bc-cost">
                {RES_KEYS.filter((k) => d.cost[k]).map((k) => (
                  <span key={k} className={res[k] >= d.cost[k]! ? '' : 'short'}>
                    <ResIcon k={k} size={10} />
                    {d.cost[k]}
                  </span>
                ))}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
