import { useEffect, useRef } from 'react';
import { FACTIONS, STRUCT, TILE_INFO } from '../game/defs';
import { hud } from '../game/game';
import { useStore } from '../game/store';

export function Tooltip() {
  const ref = useRef<HTMLDivElement>(null);
  const hover = useStore(hud, (s) => s.hover);
  const mode = useStore(hud, (s) => s.buildMode);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (ref.current) ref.current.style.transform = `translate(${e.clientX + 18}px, ${e.clientY + 16}px)`;
    };
    window.addEventListener('pointermove', move);
    return () => window.removeEventListener('pointermove', move);
  }, []);

  const owner = hover && hover.owner >= 0 ? FACTIONS[hover.owner] : null;
  const s = hover?.structure;
  return (
    <div ref={ref} className={`tooltip ${hover ? 'show' : ''}`}>
      {hover && (
        <>
          <div className="tt-title">{s ? STRUCT[s.kind].name : TILE_INFO[hover.kind].name}</div>
          <div className="tt-row">
            <span>⟨{hover.col},{hover.row}⟩</span>
            {owner ? <span style={{ color: owner.color }}>{owner.tag}</span> : <span className="dim">UNCLAIMED</span>}
          </div>
          {s && s.progress < 1 && <div className="tt-row dim">Fabricating {Math.round(s.progress * 100)}%</div>}
          {mode && <div className={`tt-build ${hover.ok ? 'ok' : 'bad'}`}>{hover.ok ? `Place ${STRUCT[mode].name}` : hover.reason}</div>}
        </>
      )}
    </div>
  );
}

export function BuildBanner() {
  const mode = useStore(hud, (s) => s.buildMode);
  if (!mode) return null;
  return (
    <div className="build-banner">
      <span className="bb-pulse" />
      PLACING <b>{STRUCT[mode].name}</b>
      <span className="dim">· highlighted sectors are valid · ESC to cancel</span>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore(hud, (s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function KeyHints() {
  return (
    <div className="keyhints">
      <span><kbd>WASD</kbd> pan</span>
      <span><kbd>Wheel</kbd> zoom</span>
      <span><kbd>1-7</kbd> build</span>
      <span><kbd>H</kbd> home</span>
      <span><kbd>Esc</kbd> cancel</span>
    </div>
  );
}
