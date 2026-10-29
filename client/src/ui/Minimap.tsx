import { useEffect, useRef } from 'react';
import { FACTIONS } from '../game/defs';
import { getEngine, hud, world } from '../game/game';
import { useStore } from '../game/store';

// Minimap pixels per world pixel (tile 32x21 world px -> 4x3 map px).
const SX = 4 / 32, SY = 3 / 21;

export function Minimap() {
  const ref = useRef<HTMLCanvasElement>(null);
  const zoom = useStore(hud, (s) => s.zoom);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const cv = ref.current, eng = getEngine();
      if (!cv || !eng) return;
      const base = eng.minimap();
      if (cv.width !== base.width) { cv.width = base.width; cv.height = base.height; }
      const g = cv.getContext('2d')!;
      g.clearRect(0, 0, cv.width, cv.height);
      g.drawImage(base, 0, 0);
      const v = eng.getView();
      g.strokeStyle = 'rgba(223,246,255,0.9)';
      g.lineWidth = 1;
      g.strokeRect(Math.round(v.x * SX) + 0.5, Math.round(v.y * SY) + 0.5, Math.round(v.w * SX), Math.round(v.h * SY));
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);

  const jump = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.buttons !== 1 && e.type !== 'pointerdown') return;
    const cv = e.currentTarget, r = cv.getBoundingClientRect();
    const mx = ((e.clientX - r.left) / r.width) * cv.width, my = ((e.clientY - r.top) / r.height) * cv.height;
    getEngine()?.centerOn(mx / SX, my / SY);
  };

  return (
    <section className="minimap panel">
      <div className="ph">
        <span className="ph-title">Tactical Map</span>
        <span className="ph-meta">{world.cols}×{world.rows}</span>
      </div>
      <div className="mm-frame">
        <canvas ref={ref} className="mm-canvas" onPointerDown={jump} onPointerMove={jump} />
      </div>
      <div className="mm-foot">
        <div className="mm-legend">
          {FACTIONS.map((f) => (
            <i key={f.id} style={{ background: f.color }} title={f.name} />
          ))}
        </div>
        <div className="zoom-ctl">
          <button onClick={() => getEngine()?.setZoom(zoom - 1)} aria-label="Zoom out">−</button>
          <span className="num">{zoom.toFixed(1)}x</span>
          <button onClick={() => getEngine()?.setZoom(zoom + 1)} aria-label="Zoom in">+</button>
          <button onClick={() => getEngine()?.goHome()} title="Return to Nexus (H)">⌂</button>
        </div>
      </div>
    </section>
  );
}
