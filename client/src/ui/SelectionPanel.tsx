import { FACTIONS, PLAYER, RES_KEYS, STRUCT, TILE_INFO } from '../game/defs';
import { getEngine, hud, world } from '../game/game';
import { assets } from '../game/sprites';
import { useStore } from '../game/store';
import { ResIcon } from './icons';

export function SelectionPanel() {
  const sel = useStore(hud, (s) => s.selected);
  if (!sel) {
    return (
      <section className="selection panel empty">
        <span className="hint">Select a sector to inspect it · Drag to pan · Scroll to zoom</span>
      </section>
    );
  }
  const tile = TILE_INFO[sel.kind];
  const s = sel.structure;
  const def = s && STRUCT[s.kind];
  const owner = sel.owner >= 0 ? FACTIONS[sel.owner] : null;
  const produce = def && s!.progress >= 1 ? def.produce(sel.kind) : null;
  const mine = s?.owner === PLAYER;

  return (
    <section className="selection panel" style={{ ['--fc' as string]: owner?.color ?? '#8698b4' }}>
      <div className="sel-portrait">
        <img src={def ? assets.icons.get(s!.kind) : assets.tileIcon(sel.kind, sel.variant)} alt="" />
      </div>
      <div className="sel-body">
        <div className="sel-head">
          <div>
            <div className="sel-kicker">
              {def ? def.role : 'Sector'} · ⟨{sel.col},{sel.row}⟩ · {tile.name}
            </div>
            <h2 className="sel-title">{def ? def.name : tile.name}</h2>
          </div>
          <div className="owner-chip">
            {owner ? (
              <>
                <i style={{ background: owner.color }} />
                {owner.name}
              </>
            ) : (
              'Unclaimed'
            )}
          </div>
        </div>
        <p className="sel-desc">{def ? def.desc : tile.desc}</p>

        {s && s.progress < 1 && (
          <div className="progress">
            <div className="progress-bar" style={{ width: `${s.progress * 100}%` }} />
            <span>FABRICATING · {Math.round(s.progress * 100)}% · {Math.ceil((1 - s.progress) * def!.buildTime)}s</span>
          </div>
        )}

        <div className="sel-stats">
          {produce &&
            RES_KEYS.filter((k) => produce[k]).map((k) => (
              <span key={k} className={`stat ${produce[k]! > 0 ? 'up' : 'down'}`}>
                <ResIcon k={k} size={14} />
                {produce[k]! > 0 ? '+' : ''}
                {produce[k]}/s
              </span>
            ))}
          {!s && tile.deposit &&
            RES_KEYS.filter((k) => tile.deposit![k]).map((k) => (
              <span key={k} className="stat deposit">
                <ResIcon k={k} size={14} /> Deposit +{tile.deposit![k]}/s
              </span>
            ))}
          {s && <span className="stat">LV {s.level}</span>}
        </div>

        {mine && (
          <div className="sel-actions">
            <button className="btn" disabled title="Coming soon">
              Upgrade
            </button>
            {s!.kind !== 'nexus' && (
              <button className="btn danger" onClick={() => getEngine()?.demolishSelected()}>
                Decommission
              </button>
            )}
          </div>
        )}
        {!s && sel.owner === PLAYER && <div className="sel-tip">Open sector. Pick a structure from Fabrication to build here.</div>}
        {!s && sel.owner === -1 && world.isAdjacentTo(sel.col, sel.row, PLAYER) && <div className="sel-tip">Frontier sector. A Claim Relay here would extend your borders.</div>}
      </div>
    </section>
  );
}
