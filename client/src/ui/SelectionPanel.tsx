import { FACTIONS, PLAYER, RES_KEYS, STRUCT, TILE_INFO } from '../game/defs';
import { getEngine, hud, world } from '../game/game';
import { assets } from '../game/sprites';
import { useStore } from '../game/store';
import { ResIcon } from './icons';
import { SpriteIcon } from './SpriteIcon';

const CONTROLS: [string, string][] = [
  ['Space', 'Pilot ship'],
  ['RMB', 'Fly to'],
  ['F', 'Find ship'],
  ['G', 'Hangar'],
  ['E', 'Aim weapons'],
  ['Drag', 'Pan'],
  ['Wheel', 'Zoom'],
  ['1–9', 'Build'],
  ['M', 'Map'],
  ['H', 'Home'],
];

export function SelectionPanel() {
  const sel = useStore(hud, (s) => s.selected);

  if (!sel) {
    return (
      <section className="selection f-panel idle">
        <div className="controls">
          {CONTROLS.map(([k, v]) => (
            <span key={k}>
              <kbd>{k}</kbd> {v}
            </span>
          ))}
        </div>
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
    <section className="selection f-panel">
      <div className="portrait f-inset">
        {def ? <SpriteIcon key={`${s!.kind}${s!.owner}`} kind={s!.kind} owner={s!.owner} k={1} glint="loop" /> : <img src={assets.tileIcon(sel.kind, sel.variant)} alt="" />}
      </div>
      <div className="sel-body">
        <h2 className="sel-title">{def ? def.name : tile.name}</h2>
        <div className="sel-meta">
          {!sel.known ? (
            <span className="muted">Syncing sector…</span>
          ) : owner ? (
            <span style={{ color: owner.color }}>{owner.name}</span>
          ) : (
            <span className="muted">Unclaimed</span>
          )}
          <span className="muted">
            {def ? tile.name : 'Sector'} {sel.col}, {sel.row}
          </span>
        </div>

        {s && s.progress < 1 ? (
          <div className="bar f-inset">
            <div className="bar-fill" style={{ width: `${s.progress * 100}%`, background: owner?.color }} />
            <span className="bar-text">Building · {Math.ceil((1 - s.progress) * def!.buildTime)}s</span>
          </div>
        ) : (
          <p className="sel-desc">{def ? def.desc : tile.desc}</p>
        )}
        {s && s.hp < s.maxHp && (
          <div className="bar f-inset">
            <div className="bar-fill" style={{ width: `${(s.hp / s.maxHp) * 100}%`, background: s.hp / s.maxHp > 0.3 ? 'var(--warn)' : 'var(--bad)' }} />
            <span className="bar-text">
              Structure · {Math.ceil(s.hp)} / {s.maxHp}
            </span>
          </div>
        )}

        <div className="sel-foot">
          <div className="yields">
            {produce &&
              RES_KEYS.filter((k) => produce[k]).map((k) => (
                <span key={k} className={produce[k]! > 0 ? 'up' : 'down'}>
                  <ResIcon k={k} size={12} />
                  {produce[k]! > 0 ? '+' : ''}
                  {produce[k]}
                </span>
              ))}
            {!s &&
              tile.deposit &&
              RES_KEYS.filter((k) => tile.deposit![k]).map((k) => (
                <span key={k} className="up">
                  <ResIcon k={k} size={12} />+{tile.deposit![k]} if mined
                </span>
              ))}
            {!s && sel.owner === -1 && world.isAdjacentTo(sel.col, sel.row, PLAYER) && <span className="hint">Frontier: a Claim Relay here expands your borders</span>}
          </div>
          {mine && s!.kind !== 'nexus' && (
            <button className="pbtn danger" onClick={() => getEngine()?.demolishSelected()}>
              Demolish
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
