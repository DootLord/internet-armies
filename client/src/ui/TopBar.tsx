import { FACTIONS, PLAYER, RES_INFO, RES_KEYS, ResKey } from '../game/defs';
import { hud } from '../game/game';
import { useStore } from '../game/store';
import { Emblem, ResIcon } from './icons';

const fmt = (n: number) => Math.floor(n).toLocaleString('en-US');

function Resource({ k }: { k: ResKey }) {
  const v = useStore(hud, (s) => s.res[k]);
  const r = useStore(hud, (s) => s.rates[k]);
  return (
    <div className="res f-well" title={`${RES_INFO[k].name} · ${r >= 0 ? '+' : ''}${r} per second`}>
      <ResIcon k={k} size={14} glow />
      <span className="res-num">{fmt(v)}</span>
      <span className={`res-rate ${r > 0 ? 'up' : r < 0 ? 'down' : ''}`}>
        {r > 0 ? '+' : ''}
        {r}
      </span>
    </div>
  );
}

export function TopBar() {
  const cycle = useStore(hud, (s) => s.cycle);
  const sectors = useStore(hud, (s) => s.sectors);
  const me = FACTIONS[PLAYER];
  return (
    <header className="topbar f-strip">
      <div className="who">
        <Emblem color={me.color} size={18} />
        <span className="who-name" style={{ color: me.color }}>
          {me.name}
        </span>
      </div>
      <div className="res-row">
        {RES_KEYS.map((k) => (
          <Resource key={k} k={k} />
        ))}
      </div>
      <div className="clock">
        <span className="muted">Kestrel Cluster</span>
        <span>
          <span className="muted">Sectors</span> <span className="num">{sectors}</span>
        </span>
        <span>
          <span className="muted">Cycle</span> <span className="num">{cycle}</span>
        </span>
      </div>
    </header>
  );
}
