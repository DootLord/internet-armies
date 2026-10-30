import { useEffect, useRef } from 'react';
import { getEngine, hud } from '../game/game';
import { useStore } from '../game/store';
import { UiIcon } from './icons';

const SIZE = 254;

export function Minimap() {
  const ref = useRef<HTMLCanvasElement>(null);
  const zoom = useStore(hud, (s) => s.zoom);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const cv = ref.current, eng = getEngine();
      if (!cv || !eng) return;
      const { canvas, rect, ship } = eng.minimap();
      const g = cv.getContext('2d')!;
      g.clearRect(0, 0, SIZE, SIZE);
      g.imageSmoothingEnabled = true;
      g.drawImage(canvas, 0, 0, SIZE, SIZE);
      const v = eng.getView(), s = SIZE / rect.w;
      // Flagship: a small heading arrow.
      g.save();
      g.translate((ship.x - rect.x) * s, (ship.y - rect.y) * s);
      g.rotate(ship.heading);
      g.fillStyle = '#49e0ff';
      g.beginPath();
      g.moveTo(5, 0);
      g.lineTo(-3, 3);
      g.lineTo(-3, -3);
      g.closePath();
      g.fill();
      g.restore();
      const x = (v.x - rect.x) * s, y = (v.y - rect.y) * s, w = v.w * s, h = v.h * s;
      g.strokeStyle = '#dff6ff';
      g.lineWidth = 1;
      // Keep the viewport marker visible even when it's smaller than a pixel.
      if (w < 6) g.strokeRect(Math.round(x + w / 2) - 3.5, Math.round(y + h / 2) - 3.5, 7, 7);
      else g.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);

  const jump = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.buttons !== 1) return;
    const eng = getEngine();
    if (!eng) return;
    const { rect } = eng.minimap(), r = e.currentTarget.getBoundingClientRect();
    eng.centerOn(rect.x + ((e.clientX - r.left) / r.width) * rect.w, rect.y + ((e.clientY - r.top) / r.height) * rect.h);
  };

  return (
    <section className="minimap f-panel">
      <div className="mm-well f-inset">
        <canvas ref={ref} width={SIZE} height={SIZE} className="mm-canvas" onPointerDown={jump} onPointerMove={jump} />
      </div>
      <div className="mm-tools">
        <button className="pbtn icon" onClick={() => getEngine()?.goHome()} title="Return to Nexus (H)">
          <UiIcon name="home" />
        </button>
        <span className="mm-zoom num">{zoom < 1 ? zoom.toFixed(2) : zoom.toFixed(1)}×</span>
        <button className="pbtn icon" onClick={() => getEngine()?.zoomBy(1 / 1.5)} title="Zoom out (−) · M for map">
          <UiIcon name="minus" />
        </button>
        <button className="pbtn icon" onClick={() => getEngine()?.zoomBy(1.5)} title="Zoom in (+)">
          <UiIcon name="plus" />
        </button>
      </div>
    </section>
  );
}
