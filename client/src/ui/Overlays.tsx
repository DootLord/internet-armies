import { useEffect, useRef } from 'react';
import { FACTIONS, STRUCT, TILE_INFO } from '../game/defs';
import { hud } from '../game/game';
import { useStore } from '../game/store';

export function Tooltip() {
  const ref = useRef<HTMLDivElement>(null);
  const hover = useStore(hud, (s) => s.hover);
  const mode = useStore(hud, (s) => s.buildMode);
  const aim = useStore(hud, (s) => s.aim);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (ref.current) ref.current.style.transform = `translate(${e.clientX + 18}px, ${e.clientY + 18}px)`;
    };
    window.addEventListener('pointermove', move);
    return () => window.removeEventListener('pointermove', move);
  }, []);

  const owner = hover && hover.owner >= 0 ? FACTIONS[hover.owner] : null;
  const s = hover?.structure;
  return (
    <div ref={ref} className={`tooltip f-tip ${hover && !aim ? 'show' : ''}`}>
      {hover && (
        <>
          <b>{s ? STRUCT[s.kind].name : TILE_INFO[hover.kind].name}</b>
          <span className="muted">
            {owner ? <span style={{ color: owner.color }}>{owner.name}</span> : 'Unclaimed'} · {hover.col}, {hover.row}
          </span>
          {mode && <span className={hover.ok ? 'ok' : 'bad'}>{hover.ok ? `Place ${STRUCT[mode].name}` : hover.reason}</span>}
        </>
      )}
    </div>
  );
}

export function BuildBanner() {
  const mode = useStore(hud, (s) => s.buildMode);
  if (!mode) return null;
  return (
    <div className="banner f-tip">
      Placing <b>{STRUCT[mode].name}</b> <span className="muted">Right-click or Esc to cancel · Shift to place several</span>
    </div>
  );
}

export function PilotBanner() {
  const pilot = useStore(hud, (s) => s.pilot);
  const mode = useStore(hud, (s) => s.buildMode);
  const aim = useStore(hud, (s) => s.aim);
  if (!pilot || mode || aim) return null;
  return (
    <div className="banner f-tip pilot">
      <b>Pilot</b> <span className="muted">W/S thrust · A/D steer · Shift boost · E aim weapons · Space or Esc to exit</span>
    </div>
  );
}

export function AimBanner() {
  const aim = useStore(hud, (s) => s.aim);
  if (!aim) return null;
  return (
    <div className="banner f-tip aim">
      <b>Weapons hot</b> <span className="muted">Hold LMB to fire at the cursor · E or Esc to stand down</span>
    </div>
  );
}

export function DeployBanner() {
  const on = useStore(hud, (s) => s.deploying);
  if (!on) return null;
  return (
    <div className="banner f-tip aim">
      <b>Deploy mech</b> <span className="muted">Click an enemy structure to assault · RMB or Esc to cancel</span>
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
