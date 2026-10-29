// Pixel-art UI chrome, generated from the same material ramps as the world so
// HUD and game read as one piece. Each frame is a tiny 9-slice PNG exposed as a
// CSS variable and scaled by an integer UI unit (--u) with pixelated sampling.
import { accentRamp, hex, mix, OUTLINE, RGB, STEEL } from '../game/palette';
import { Pix } from '../game/sprites';

interface Ring { light: RGB; dark: RGB; mid?: RGB }
interface FrameSpec { size: number; chamfer: number; rings: Ring[]; fill: RGB; fillA?: number; sheen?: RGB; rivets?: boolean }

const all = (c: RGB): Ring => ({ light: c, dark: c, mid: c });

function frame({ size: S, chamfer: c, rings, fill, fillA = 255, sheen, rivets }: FrameSpec) {
  const p = new Pix(S, S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const dl = x, dt = y, dr = S - 1 - x, db = S - 1 - y;
      const tl = x + y - c, tr = dr + y - c, bl = x + db - c, br = dr + db - c;
      if (tl < 0 || tr < 0 || bl < 0 || br < 0) continue;
      const d = Math.min(dl, dt, dr, db, tl, tr, bl, br);
      if (d < rings.length) {
        const r = rings[d];
        const side = d === dt || d === dl || d === tl ? r.light : d === db || d === dr || d === br ? r.dark : r.mid ?? r.light;
        p.set(x, y, side);
      } else if (sheen && d === rings.length && (d === dt || d === tl)) p.set(x, y, sheen, fillA);
      else p.set(x, y, fill, fillA);
    }
  if (rivets)
    for (const [x, y] of [[3, 3], [S - 4, 3], [3, S - 4], [S - 4, S - 4]]) {
      p.set(x, y, STEEL[8]);
      p.set(x + 1, y + 1, STEEL[1]);
    }
  return `url(${p.toCanvas().toDataURL()})`;
}

const ACC = accentRamp(hex('#49e0ff'));

export function installSkin() {
  const root = document.documentElement.style;
  const frames: Record<string, string> = {
    panel: frame({
      size: 20, chamfer: 3, fill: hex('#0b101b'), fillA: 245, sheen: STEEL[2], rivets: true,
      rings: [
        all(OUTLINE),
        { light: STEEL[7], dark: STEEL[3], mid: STEEL[5] },
        { light: STEEL[5], dark: STEEL[3], mid: STEEL[4] },
        { light: STEEL[4], dark: STEEL[2], mid: STEEL[3] },
        all(OUTLINE),
      ],
    }),
    inset: frame({ size: 12, chamfer: 2, fill: hex('#04060b'), rings: [{ light: STEEL[1], dark: STEEL[5], mid: STEEL[3] }, all(OUTLINE)] }),
    btn: frame({ size: 12, chamfer: 2, fill: STEEL[2], sheen: STEEL[4], rings: [all(OUTLINE), { light: STEEL[6], dark: STEEL[1], mid: STEEL[4] }] }),
    'btn-hover': frame({ size: 12, chamfer: 2, fill: STEEL[3], sheen: STEEL[5], rings: [all(OUTLINE), { light: STEEL[7], dark: STEEL[2], mid: STEEL[5] }] }),
    'btn-down': frame({ size: 12, chamfer: 2, fill: STEEL[1], rings: [all(OUTLINE), { light: STEEL[0], dark: STEEL[4], mid: STEEL[2] }] }),
    'btn-on': frame({
      size: 12, chamfer: 2, fill: mix(STEEL[1], ACC[1], 0.35), sheen: mix(STEEL[2], ACC[2], 0.4),
      rings: [all(OUTLINE), { light: ACC[3], dark: ACC[1], mid: ACC[2] }],
    }),
    tip: frame({ size: 8, chamfer: 1, fill: hex('#070a12'), fillA: 245, rings: [all(OUTLINE), { light: STEEL[5], dark: STEEL[3], mid: STEEL[4] }] }),
  };
  for (const [k, v] of Object.entries(frames)) root.setProperty(`--f-${k}`, v);

  // One UI pixel = an integer number of *device* pixels, so frames never blur
  // on fractional display scaling (125%, 150% laptops).
  const fit = () => {
    const dpr = window.devicePixelRatio || 1;
    const target = window.innerWidth < 900 ? 1.5 : window.innerWidth > 2400 ? 3 : 2;
    root.setProperty('--u', `${Math.max(1, Math.round(target * dpr)) / dpr}px`);
  };
  fit();
  window.addEventListener('resize', fit);
}
