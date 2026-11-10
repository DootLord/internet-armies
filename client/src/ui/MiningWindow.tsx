import { useEffect, useRef, useState } from 'react';
import { itemPose } from '../game/itemArt';
import { Dig, FREE_AT, MAX_CHARGE, NODE, NodeKind, Tool, TOOLS } from '../game/mining/excavation';
import { DIG_H, DIG_W, DigRenderer, pickCell } from '../game/mining/digRender';
import { ItemKind, ITEMS } from '../game/ships/cargo';
import { UiIcon } from './icons';

/** What the HUD needs from the dig, refreshed a few times a second (the canvas runs every frame). */
interface Snap {
  heat: number;
  overheated: boolean;
  charge: number;
  scans: number;
  finds: { id: number; kind: ItemKind; state: 'buried' | 'recovered' | 'lost'; exposure: number; integrity: number }[];
  done: boolean;
}
const snap = (d: Dig): Snap => ({
  heat: d.heat, overheated: d.overheated, charge: d.charge, scans: d.scans, done: d.done,
  finds: d.finds.map((f) => ({ id: f.id, kind: f.kind, state: f.state, exposure: d.exposure(f), integrity: f.integrity })),
});

function Gauge({ label, value, kind, low }: { label: string; value: number; kind: string; low?: boolean }) {
  return (
    <div className="budget">
      <span className="muted">{label}</span>
      <div className="budget-bar f-inset">
        <div className={`budget-fill ${kind} ${low ? 'low' : ''}`} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
      </div>
      <span className="num">{Math.round(value * 100)}%</span>
    </div>
  );
}

/**
 * The mining mini-game: cut a node's rock away with the ship's mining laser to
 * free what's buried in it, without burning the finds. Self-contained so it can
 * open as a window in the game (from a deposit tile) or on its own test page.
 */
export function MiningWindow({ seed, node, onClose, onCollect }: { seed: number; node: NodeKind; onClose: () => void; onCollect: (haul: ItemKind[]) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>(TOOLS[0]);
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const digRef = useRef<Dig | null>(null);
  const rendRef = useRef<DigRenderer | null>(null);
  const [hud, setHud] = useState<Snap | null>(null);

  useEffect(() => {
    const dig = new Dig(seed, node);
    digRef.current = dig;
    setHud(snap(dig));
    const cv = canvas.current!;
    // Whole device pixels per art pixel, like the world view, so the pixel art stays crisp.
    const dpr = window.devicePixelRatio || 1, s = Math.max(2, Math.round(2 * dpr) * 2);
    cv.width = DIG_W * s;
    cv.height = DIG_H * s;
    cv.style.width = `${(DIG_W * s) / dpr}px`;
    cv.style.height = `${(DIG_H * s) / dpr}px`;
    const rend = new DigRenderer(cv, dig);
    rendRef.current = rend;

    let at: { x: number; y: number } | null = null, firing = false, raf = 0, last = 0, hudAcc = 0;
    const toArt = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * DIG_W, y: ((e.clientY - r.top) / r.height) * DIG_H };
    };
    const move = (e: PointerEvent) => (at = toArt(e));
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      cv.setPointerCapture(e.pointerId);
      at = toArt(e);
      firing = true;
    };
    const up = () => (firing = false);
    const leave = () => {
      if (!firing) at = null;
    };
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', leave);

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - (last || now)) / 1000), t = now / 1000;
      last = now;
      const d = digRef.current!, tl = toolRef.current;
      const aim = at && !d.done ? pickCell(d, at.x, at.y) : null;
      const live = firing && !!aim && d.canFire;
      if (live) rend.burned(d.fire(tl, aim!.x, aim!.y, dt), tl, aim!.x, aim!.y, dt);
      else d.cool(dt);
      rend.frame(dt, t, tl, d.done ? null : at, live, s);
      hudAcc += dt;
      if (hudAcc > 0.1) {
        hudAcc = 0;
        setHud(snap(d));
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerdown', down);
      cv.removeEventListener('pointerup', up);
      cv.removeEventListener('pointercancel', up);
      cv.removeEventListener('pointerleave', leave);
      rend.dispose();
    };
  }, [seed, node]);

  const scan = () => {
    if (digRef.current?.scan()) rendRef.current?.scan();
  };

  // 1 / 2 pick the beam, S scans, Esc closes. In the game this window is modal, so these don't reach the map.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === '1' || k === '2') setTool(TOOLS[Number(k) - 1]);
      else if (k === 's' && !e.repeat) scan();
      else if (k === 'escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const info = NODE[node];
  const haul = hud?.finds.filter((f) => f.state === 'recovered').map((f) => f.kind) ?? [];
  return (
    <section className="mining-win f-panel">
      <header className="fit-head">
        <b>{info.name}</b>
        <span className="muted">{info.desc}</span>
        <button className="pbtn icon" onClick={onClose} title="Close (Esc)">
          <UiIcon name="close" />
        </button>
      </header>
      <div className="mining-body">
        <div className="mining-view f-inset">
          <canvas ref={canvas} className={tool.id} />
          {hud?.done && (
            <div className="mining-done f-tip">
              <b>{hud.charge <= 0 ? 'Laser charge spent' : 'Node cleared'}</b>
              <span className="muted">
                Recovered {haul.length} of {hud.finds.length}
                {hud.finds.some((f) => f.state === 'lost') ? `, ${hud.finds.filter((f) => f.state === 'lost').length} destroyed` : ''}
              </span>
              <button className="pbtn wide" onClick={() => onCollect(haul)}>
                {haul.length ? 'Load into hold' : 'Leave'}
              </button>
            </div>
          )}
        </div>
        <aside className="mining-side">
          <div className="mining-tools">
            {TOOLS.map((tl, i) => (
              <button key={tl.id} className={`pbtn mining-tool ${tool.id === tl.id ? 'on' : ''}`} onClick={() => setTool(tl)} title={tl.desc}>
                <kbd>{i + 1}</kbd> {tl.name}
              </button>
            ))}
          </div>
          <p className="muted mining-hint">{tool.desc}</p>
          {hud && (
            <>
              <Gauge label="Heat" value={hud.heat} kind="hot" low={hud.overheated} />
              <Gauge label="Charge" value={hud.charge / MAX_CHARGE} kind="hp" low={hud.charge < 20} />
              {hud.overheated && <span className="bad">Overheated: let it cool</span>}
              <button className="pbtn wide" onClick={scan} disabled={!hud.scans}>
                <kbd>S</kbd> Scan ({hud.scans})
              </button>
              <div className="mining-finds">
                {hud.finds.map((f) => (
                  <div key={f.id} className={`mining-find ${f.state}`}>
                    {f.state === 'buried' && f.exposure === 0 ? (
                      <span className="mining-unknown f-well">?</span>
                    ) : (
                      <img src={itemPose(f.kind, false, 0)} alt="" className={f.state === 'lost' ? 'lost' : ''} />
                    )}
                    <span>{f.state === 'buried' && f.exposure === 0 ? 'Buried' : ITEMS[f.kind].name}</span>
                    <span className="num">
                      {f.state === 'recovered' ? 'Got it' : f.state === 'lost' ? 'Destroyed' : `${Math.round(Math.min(1, f.exposure / FREE_AT) * 100)}%`}
                    </span>
                    {f.state === 'buried' && f.integrity < 1 && (
                      <div className="mining-integrity">
                        <div style={{ width: `${f.integrity * 100}%` }} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {!hud.done && (
                <button className="pbtn wide" onClick={() => onCollect(haul)}>
                  Finish {haul.length ? `(${haul.length})` : ''}
                </button>
              )}
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
