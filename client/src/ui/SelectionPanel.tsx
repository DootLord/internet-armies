import { FACTIONS, PLAYER, RES_KEYS, STRUCT, TILE_INFO } from '../game/defs';
import { getEngine, hud, world } from '../game/game';
import { assets } from '../game/sprites';
import { useStore } from '../game/store';
import { SQUAD_COST } from '../game/units';
import { ResIcon } from './icons';
import { SpriteIcon } from './SpriteIcon';
import { useTick } from './useReach';

const CONTROLS: [string, string][] = [
  ['Space', 'Pilot ship'],
  ['RMB', 'Fly to'],
  ['F', 'Find ship'],
  ['G', 'Ship'],
  ['E', 'Aim weapons'],
  ['T', 'Deploy mech'],
  ['Drag', 'Pan'],
  ['Wheel', 'Zoom'],
  ['1–0', 'Build'],
  ['M', 'Map'],
  ['H', 'Home'],
];

/** Mech Bay: send a squad. Shows its cost, or the countdown while the next one trains. */
function DeployButton({ id }: { id: number }) {
  const deploying = useStore(hud, (s) => s.deploying);
  const res = useStore(hud, (s) => s.res);
  const wait = getEngine()?.deployCooldown(id) ?? 0;
  useTick(wait > 0);
  const afford = RES_KEYS.every((k) => res[k] >= (SQUAD_COST[k as keyof typeof SQUAD_COST] ?? 0));
  if (wait > 0) return <button className="pbtn wide" disabled>Training · {Math.ceil(wait)}s</button>;
  return (
    <button className={`pbtn wide ${deploying ? 'on' : ''}`} disabled={!afford} title="T" onClick={() => (deploying ? getEngine()?.cancelDeploy() : getEngine()?.deploySelected())}>
      {deploying ? 'Pick a target…' : 'Deploy mech'}
      {!deploying &&
        RES_KEYS.filter((k) => SQUAD_COST[k as keyof typeof SQUAD_COST]).map((k) => (
          <span key={k} className="muted">
            {' '}
            <ResIcon k={k} size={11} />
            {SQUAD_COST[k as keyof typeof SQUAD_COST]}
          </span>
        ))}
    </button>
  );
}

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
          {sel.kind === 'cache' && (
            <button className="pbtn wide" onClick={() => getEngine()?.openSelectedCache()}>
              Open cache
            </button>
          )}
          {mine && s!.kind === 'mechbay' && s!.progress >= 1 && <DeployButton id={s!.id} />}
          {mine && s!.kind === 'hangar' && s!.progress >= 1 && (
            <button className="pbtn wide" onClick={() => hud.set({ hangarOpen: s!.id })}>
              Open hangar
            </button>
          )}
          {mine && s!.kind === 'storage' && s!.progress >= 1 && (
            <button className="pbtn wide" onClick={() => hud.set({ storageOpen: s!.id })}>
              Open storage
            </button>
          )}
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
