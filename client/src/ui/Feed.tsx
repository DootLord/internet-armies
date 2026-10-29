import { FACTIONS } from '../game/defs';
import { getEngine, hud } from '../game/game';
import { useStore } from '../game/store';

/** Game-style message log: bare outlined text over the map, older lines fade. */
export function Feed() {
  const feed = useStore(hud, (s) => s.feed);
  return (
    <ol className="log">
      {feed.slice(0, 6).map((ev, i) => {
        const f = ev.faction >= 0 ? FACTIONS[ev.faction] : null;
        const jump = ev.col !== undefined ? () => getEngine()?.focusTile(ev.col!, ev.row!) : undefined;
        return (
          <li key={ev.id} className={`log-line ${jump ? 'link' : ''} ${f ? '' : 'sys'}`} style={{ opacity: 1 - i * 0.13 }} onClick={jump}>
            {f && <b style={{ color: f.color }}>{f.name}</b>} {ev.text}
          </li>
        );
      })}
    </ol>
  );
}
