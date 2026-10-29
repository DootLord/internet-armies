// Pixel-art UI chrome, generated from the same material ramps as the world so
// HUD and game read as one piece. Each frame is a tiny 9-slice PNG exposed as a
// CSS variable and scaled by an integer UI unit (--u) with pixelated sampling.
//
// Like world sprites, every frame has companion layers:
//   --fs-*  shine mask (lit bevel pixels) that a moving band sweeps across
//   --fg-*  emissive pixels, blurred in CSS to fake the game's bloom
import { accentRamp, C_WHITE, hex, mix, OUTLINE, RGB, STEEL } from '../game/palette';
import { Pix } from '../game/sprites';

interface Ring { light: RGB; dark: RGB; mid?: RGB }
type Side = 'light' | 'dark' | 'mid';
interface FrameSpec {
  size: number;
  chamfer: number;
  rings: Ring[];
  fill: RGB;
  fillA?: number;
  sheen?: RGB;
  rivets?: boolean;
  /** Emissive pixels (must sit inside the corner slices, or they'd be stretched). */
  lights?: [number, number][];
  /** Make one bevel ring emissive on the given sides. */
  glowRing?: { ring: number; sides: Side[] };
  glow?: RGB;
}

const all = (c: RGB): Ring => ({ light: c, dark: c, mid: c });
const url = (p: Pix) => `url(${p.toCanvas().toDataURL()})`;

function frame(spec: FrameSpec) {
  const { size: S, chamfer: c, rings, fill, fillA = 255, sheen, glow = ACC[2] } = spec;
  const img = new Pix(S, S), shine = new Pix(S, S), em = new Pix(S, S);
  let glows = false;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const dl = x, dt = y, dr = S - 1 - x, db = S - 1 - y;
      const tl = x + y - c, tr = dr + y - c, bl = x + db - c, br = dr + db - c;
      if (tl < 0 || tr < 0 || bl < 0 || br < 0) continue;
      const d = Math.min(dl, dt, dr, db, tl, tr, bl, br);
      if (d < rings.length) {
        const r = rings[d];
        const side: Side = d === dt || d === dl || d === tl ? 'light' : d === db || d === dr || d === br ? 'dark' : 'mid';
        img.set(x, y, side === 'light' ? r.light : side === 'dark' ? r.dark : r.mid ?? r.light);
        if (side === 'light' && r.light !== OUTLINE) shine.set(x, y, C_WHITE);
        if (spec.glowRing?.ring === d && spec.glowRing.sides.includes(side)) { em.set(x, y, glow); glows = true; }
      } else if (sheen && d === rings.length && (d === dt || d === tl)) {
        img.set(x, y, sheen, fillA);
        shine.set(x, y, C_WHITE, 110);
      } else img.set(x, y, fill, fillA);
    }
  if (spec.rivets)
    for (const [x, y] of [[3, 3], [S - 4, 3], [3, S - 4], [S - 4, S - 4]]) {
      img.set(x, y, STEEL[8]);
      img.set(x + 1, y + 1, STEEL[1]);
      shine.set(x, y, C_WHITE);
    }
  for (const [x, y] of spec.lights ?? []) {
    img.set(x, y, mix(glow, C_WHITE, 0.5));
    em.set(x, y, glow);
    glows = true;
  }
  return { img: url(img), shine: url(shine), glow: glows ? url(em) : 'none' };
}

const ACC = accentRamp(hex('#49e0ff'));

export function installSkin() {
  const root = document.documentElement.style;
  const S = 20;
  const frames = {
    panel: frame({
      size: S, chamfer: 3, fill: hex('#0b101b'), fillA: 245, sheen: STEEL[2], rivets: true,
      rings: [
        all(OUTLINE),
        { light: STEEL[7], dark: STEEL[3], mid: STEEL[5] },
        { light: STEEL[5], dark: STEEL[3], mid: STEEL[4] },
        { light: STEEL[4], dark: STEEL[2], mid: STEEL[3] },
        all(OUTLINE),
      ],
      lights: [[5, 1], [6, 1], [5, 2], [6, 2], [S - 7, 1], [S - 6, 1], [S - 7, 2], [S - 6, 2]],
    }),
    // Slim bar for the top HUD: 4px of chrome, glowing lower bevel.
    strip: frame({
      size: 10, chamfer: 2, fill: hex('#0b101b'), fillA: 245, sheen: STEEL[2],
      rings: [all(OUTLINE), { light: STEEL[7], dark: STEEL[3], mid: STEEL[5] }, { light: STEEL[4], dark: STEEL[2], mid: STEEL[3] }],
      glowRing: { ring: 1, sides: ['dark'] },
      glow: ACC[1],
    }),
    inset: frame({ size: 12, chamfer: 2, fill: hex('#04060b'), rings: [{ light: STEEL[1], dark: STEEL[5], mid: STEEL[3] }, all(OUTLINE)] }),
    well: frame({ size: 6, chamfer: 1, fill: hex('#04060b'), rings: [{ light: OUTLINE, dark: STEEL[4], mid: STEEL[2] }] }),
    btn: frame({ size: 12, chamfer: 2, fill: STEEL[2], sheen: STEEL[4], rings: [all(OUTLINE), { light: STEEL[6], dark: STEEL[1], mid: STEEL[4] }] }),
    'btn-hover': frame({ size: 12, chamfer: 2, fill: STEEL[3], sheen: STEEL[5], rings: [all(OUTLINE), { light: STEEL[7], dark: STEEL[2], mid: STEEL[5] }] }),
    'btn-down': frame({ size: 12, chamfer: 2, fill: STEEL[1], rings: [all(OUTLINE), { light: STEEL[0], dark: STEEL[4], mid: STEEL[2] }] }),
    'btn-on': frame({
      size: 12, chamfer: 2, fill: mix(STEEL[1], ACC[1], 0.35), sheen: mix(STEEL[2], ACC[2], 0.4),
      rings: [all(OUTLINE), { light: ACC[3], dark: ACC[1], mid: ACC[2] }],
      glowRing: { ring: 1, sides: ['light', 'mid', 'dark'] },
    }),
    tip: frame({ size: 8, chamfer: 1, fill: hex('#070a12'), fillA: 245, rings: [all(OUTLINE), { light: STEEL[5], dark: STEEL[3], mid: STEEL[4] }] }),
  };
  for (const [k, f] of Object.entries(frames)) {
    root.setProperty(`--f-${k}`, f.img);
    root.setProperty(`--fs-${k}`, f.shine);
    root.setProperty(`--fg-${k}`, f.glow);
  }

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
