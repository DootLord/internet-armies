import { BUILDABLE, RES_KEYS } from '../game/defs';
import { getEngine, hud } from '../game/game';
import { useStore } from '../game/store';
import { ResIcon } from './icons';
import { SpriteIcon } from './SpriteIcon';

export function BuildDock() {
  const mode = useStore(hud, (s) => s.buildMode);
  const res = useStore(hud, (s) => s.res);
  return (
    <section className="build f-panel">
      <div className="build-grid">
        {BUILDABLE.map((d, i) => {
          const afford = RES_KEYS.every((k) => res[k] >= (d.cost[k] ?? 0));
          return (
            <button
              key={d.kind}
              className={`pbtn card ${mode === d.kind ? 'on' : ''} ${afford ? '' : 'poor'}`}
              onClick={() => getEngine()?.setBuildMode(mode === d.kind ? null : d.kind)}
            >
              <kbd className="card-key">{i + 1}</kbd>
              <SpriteIcon kind={d.kind} k={0.5} />
              <span className="card-name">{d.name}</span>
              <span className="card-tip f-tip">
                <b>{d.name}</b>
                <span className="muted">{d.desc}</span>
                <span className="card-cost">
                  {RES_KEYS.filter((k) => d.cost[k]).map((k) => (
                    <span key={k} className={res[k] >= d.cost[k]! ? '' : 'short'}>
                      <ResIcon k={k} size={12} />
                      {d.cost[k]}
                    </span>
                  ))}
                  <span className="muted">{d.buildTime}s</span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
