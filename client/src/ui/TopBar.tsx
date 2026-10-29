import { FACTIONS, PLAYER, RES_INFO, RES_KEYS, ResKey } from '../game/defs';
import { hud } from '../game/game';
import { useStore } from '../game/store';
import { ResIcon } from './icons';

const fmt = (n: number) => Math.floor(n).toLocaleString('en-US');

function ResChip({ k }: { k: ResKey }) {
  const v = useStore(hud, (s) => s.res[k]);
  const r = useStore(hud, (s) => s.rates[k]);
  return (
    <div className="res-chip" title={`${RES_INFO[k].name}: ${r >= 0 ? '+' : ''}${r}/s`}>
      <ResIcon k={k} />
      <div className="res-val">
        <span className="num">{fmt(v)}</span>
        <span className={`rate ${r > 0 ? 'up' : r < 0 ? 'down' : ''}`}>
          {r > 0 ? '+' : ''}
          {r}/s
        </span>
      </div>
      <span className="res-label">{RES_INFO[k].name}</span>
    </div>
  );
}

export function TopBar() {
  const cycle = useStore(hud, (s) => s.cycle);
  const sectors = useStore(hud, (s) => s.sectors);
  const me = FACTIONS[PLAYER];
  return (
    <header className="topbar panel">
      <div className="brand">
        <div className="brand-mark" />
        <div>
          <div className="brand-name">INTERNET ARMIES</div>
          <div className="brand-sub">KESTREL CLUSTER // SHARD 01</div>
        </div>
      </div>
      <div className="res-row">
        {RES_KEYS.map((k) => (
          <ResChip key={k} k={k} />
        ))}
      </div>
      <div className="top-right">
        <div className="faction-chip" style={{ ['--fc' as string]: me.color }}>
          <span className="tag">{me.tag}</span>
          <span className="fname">{me.name}</span>
          <span className="sectors">{sectors} SECTORS</span>
        </div>
        <div className="cycle">
          <span className="label">CYCLE</span>
          <span className="num">{cycle}</span>
        </div>
        <div className="online">
          <i className="live-dot" /> 1,284 <span className="label">ONLINE</span>
        </div>
      </div>
    </header>
  );
}
