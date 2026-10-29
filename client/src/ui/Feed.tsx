import { FACTIONS, PLAYER } from '../game/defs';
import { getEngine, hud } from '../game/game';
import { useStore } from '../game/store';

export function Feed() {
  const feed = useStore(hud, (s) => s.feed);
  return (
    <section className="feed panel">
      <div className="ph">
        <span className="ph-title">Comms Feed</span>
        <span className="ph-meta">LOCAL // 5 FACTIONS</span>
      </div>
      <ol className="feed-list">
        {feed.slice(0, 8).map((ev) => {
          const f = ev.faction >= 0 ? FACTIONS[ev.faction] : null;
          return (
            <li
              key={ev.id}
              className={`feed-item ${ev.faction === PLAYER ? 'mine' : ''} ${ev.type}`}
              style={{ ['--fc' as string]: f?.color ?? '#8698b4' }}
              onClick={() => ev.col !== undefined && getEngine()?.focusTile(ev.col, ev.row!)}
            >
              <span className="feed-time">{ev.cycle}</span>
              <span className="feed-text">
                {f && <b className="feed-tag">{f.tag}</b>} {ev.text}
                {ev.col !== undefined && <span className="feed-loc"> ⟨{ev.col},{ev.row}⟩</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
