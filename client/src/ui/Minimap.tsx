import { useEffect, useRef } from 'react';
import { getEngine, hud } from '../game/game';
import { useStore } from '../game/store';
import { UiIcon } from './icons';

// Minimap pixels per world pixel (tile 32x21 world px -> 3x2 map px).
const SX = 3 / 32, SY = 2 / 21;

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
      g.strokeStyle = '#dff6ff';
      g.lineWidth = 1;
      g.strokeRect(Math.round(v.x * SX) + 0.5, Math.round(v.y * SY) + 0.5, Math.round(v.w * SX), Math.round(v.h * SY));
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);

  const jump = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.buttons !== 1) return;
    const cv = e.currentTarget, r = cv.getBoundingClientRect();
    getEngine()?.centerOn((((e.clientX - r.left) / r.width) * cv.width) / SX, (((e.clientY - r.top) / r.height) * cv.height) / SY);
  };

  return (
    <section className="minimap f-panel">
      <div className="mm-well f-inset">
        <canvas ref={ref} className="mm-canvas" onPointerDown={jump} onPointerMove={jump} />
      </div>
      <div className="mm-tools">
        <button className="pbtn icon" onClick={() => getEngine()?.goHome()} title="Return to Nexus (H)">
          <UiIcon name="home" />
        </button>
        <span className="mm-zoom num">{zoom.toFixed(1)}×</span>
        <button className="pbtn icon" onClick={() => getEngine()?.setZoom(zoom - 1)} title="Zoom out (−)">
          <UiIcon name="minus" />
        </button>
        <button className="pbtn icon" onClick={() => getEngine()?.setZoom(zoom + 1)} title="Zoom in (+)">
          <UiIcon name="plus" />
        </button>
      </div>
    </section>
  );
}
