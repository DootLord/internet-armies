import { useEffect, useRef } from 'react';
import { HullId, hullSprites } from '../game/ships/hulls';
import { YAW_STEPS } from '../game/ships/voxel';

/**
 * A hull rendered like the world: crisp colour + emissive layers, plus a
 * blurred emissive copy standing in for bloom. `spin` turns it slowly.
 */
export function ShipPreview({ hull, faction = 0, maxPx, spin = false, heading = 56 }: { hull: HullId; faction?: number; maxPx: number; spin?: boolean; heading?: number }) {
  const color = useRef<HTMLCanvasElement>(null);
  const emit = useRef<HTMLCanvasElement>(null);
  const bloom = useRef<HTMLCanvasElement>(null);
  const sprites = hullSprites(hull, faction);
  const S = sprites.size;
  // Largest whole-number scale that fits, so pixels stay square and crisp.
  const scale = Math.max(1, Math.floor(maxPx / S));

  useEffect(() => {
    let yaw = heading, raf = 0, last = 0;
    const draw = () => {
      const f = sprites.frame(yaw, 0);
      for (const [ref, src] of [[color, f.color], [emit, f.emit], [bloom, f.emit]] as const) {
        const g = ref.current?.getContext('2d');
        if (!g) continue;
        g.clearRect(0, 0, S, S);
        g.drawImage(src, 0, 0);
      }
    };
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 90) return;
      last = t;
      yaw = (yaw + 1) % YAW_STEPS;
      draw();
    };
    draw();
    if (spin) raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hull, faction, spin, heading, sprites, S]);

  const style = { width: S * scale, height: S * scale };
  return (
    <span className="ship-preview" style={style}>
      <canvas ref={color} width={S} height={S} style={style} />
      <canvas ref={emit} width={S} height={S} style={style} className="emit" />
      <canvas ref={bloom} width={S} height={S} style={style} className="bloom" />
    </span>
  );
}
