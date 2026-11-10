// Draws a Dig the way the world is drawn: low-res pixel art in colour, emissive
// and light layers at the world's camera pitch, composited by the same WebGL
// post pass (bloom, light map, grade). Stone stacks are little raised blocks
// with their strata showing on the cut faces, so digging reads as depth.
import { itemColor, itemSprite } from '../itemArt';
import { accentRamp, C_AMBER, css, hex, mix, OUTLINE, ramp, RGB, ROCK } from '../palette';
import { Post } from '../post';
import { hash2 } from '../rng';
import { assets } from '../sprites';
import { BurnResult, COLS, DEPTH, Dig, Find, ROWS, Stone, STONE, Tool } from './excavation';

/** Cell width, row step (foreshortened by the camera pitch) and layer height, in art px. */
export const CW = 6, RH = 5, LH = 3;
const PAD = 6;
const OX = PAD, OY = PAD + DEPTH * LH + 4;
/** The dig's size in art px. */
export const DIG_W = COLS * CW + PAD * 2, DIG_H = OY + ROWS * RH + PAD;

const STONE_RAMP: Record<Stone, RGB[]> = {
  regolith: ramp('#160f0c', '#2a1d18', '#3d2a21', '#55392b', '#6e4b37', '#8a6145', '#a67c5a'),
  basalt: ROCK,
  obsidian: ramp('#05040a', '#0d0b16', '#171427', '#221d3a', '#302950', '#433a6c', '#5b4f8e'),
};
const BEAM = '#49e0ff';
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (x: number, y: number) => BAYER[(y & 3) * 4 + (x & 3)] / 16;

interface Part { x: number; y: number; vx: number; vy: number; life: number; max: number; col: string; glow: boolean; g: number }
interface Layer { cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D }
const layer = (): Layer => {
  const cv = document.createElement('canvas');
  cv.width = DIG_W;
  cv.height = DIG_H;
  const ctx = cv.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return { cv, ctx };
};

/** Where the cursor lands on the dig: the frontmost stack whose top or cut face is under it. */
export function pickCell(dig: Dig, mx: number, my: number) {
  const x = (mx - OX) / CW;
  if (x < 0 || x >= COLS) return null;
  const c = Math.floor(x);
  for (let r = ROWS - 1; r >= 0; r--) {
    const top = OY + r * RH - dig.layers(c, r) * LH;
    if (my >= top && my < top + RH + (dig.layers(c, r) - dig.layers(c, r + 1)) * LH) return { x, y: r + Math.min(0.99, Math.max(0, (my - top) / RH)) };
  }
  const y = (my - OY) / RH;
  return y >= 0 && y < ROWS ? { x, y } : null;
}

export class DigRenderer {
  private post: Post;
  private bg = layer();
  private col = layer();
  private emit = layer();
  private light = layer();
  private parts: Part[] = [];
  /** Per cell: how hot the stone glows from the beam, fading after it moves on. */
  private glow = new Float32Array(COLS * ROWS);
  /** Recovered finds lifting out of the dig: id -> seconds since freed. */
  private lifting = new Map<number, number>();
  private scanT = 0;
  private shake = 0;
  /** Seconds left of the warning flash after the beam touched a find. */
  private warn = 0;

  constructor(readonly canvas: HTMLCanvasElement, private dig: Dig) {
    this.post = new Post(canvas);
    this.paintBackground();
  }

  dispose() {
    this.post.dispose();
  }

  setDig(dig: Dig) {
    this.dig = dig;
    this.parts = [];
    this.glow.fill(0);
    this.lifting.clear();
    this.scanT = 0;
  }

  scan() {
    this.scanT = 2.5;
  }

  /** Effects for one tick of the beam. */
  burned(r: BurnResult, tool: Tool, cx: number, cy: number, dt: number) {
    const rad = tool.radius;
    for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++)
      for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
        if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue;
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d <= rad) this.glow[y * COLS + x] = Math.min(1, this.glow[y * COLS + x] + dt * 3 * (1 - d / rad));
      }
    for (const p of r.popped) {
      // A layer cracks off: chips of that stone fly up and fall back.
      const [sx, sy] = this.cellTop(p.x, p.y, this.dig.layers(p.x, p.y) + 1), rr = STONE_RAMP[p.stone];
      for (let i = 0; i < 5; i++) {
        const life = 0.5 + Math.random() * 0.5;
        this.parts.push({ x: sx + Math.random() * CW, y: sy + Math.random() * RH, vx: (Math.random() - 0.5) * 50, vy: -30 - Math.random() * 40, life, max: life, col: css(rr[3 + Math.floor(Math.random() * 3)]), glow: false, g: 160 });
      }
      if (p.stone === 'obsidian') this.shake = Math.max(this.shake, 1);
    }
    if (r.grazing) {
      // The beam is on a find: the reticle flashes red and it spits hot pink sparks.
      this.warn = 0.25;
      const [sx, sy] = this.cellTop(Math.floor(cx), Math.floor(cy), 0);
      if (Math.random() < dt * 40) {
        const life = 0.3 + Math.random() * 0.3;
        this.parts.push({ x: sx + CW / 2, y: sy + RH / 2, vx: (Math.random() - 0.5) * 60, vy: -30 - Math.random() * 40, life, max: life, col: '#ff5a9a', glow: true, g: 200 });
      }
    }
    for (const f of r.recovered) this.lifting.set(f.id, 0);
    for (const f of r.lost) this.shatter(f);
  }

  /** Top-left of a cell's top face, as if it had `n` layers. */
  private cellTop(x: number, y: number, n: number): [number, number] {
    return [OX + x * CW, OY + y * RH - n * LH];
  }

  private shatter(f: Find) {
    const [x0, y0] = this.cellTop(f.x, f.y, 0), c = hex(itemColor(f.kind)), acc = accentRamp(c);
    for (let i = 0; i < 40; i++) {
      const life = 0.6 + Math.random() * 0.8;
      this.parts.push({
        x: x0 + Math.random() * f.w * CW, y: y0 + Math.random() * f.h * RH, vx: (Math.random() - 0.5) * 90, vy: -40 - Math.random() * 60,
        life, max: life, col: css(acc[1 + Math.floor(Math.random() * 4)]), glow: Math.random() < 0.5, g: 180,
      });
    }
    this.shake = Math.max(this.shake, 3);
  }

  /** Static backdrop: a dark, dithered well behind the slab. */
  private paintBackground() {
    const g = this.bg.ctx, img = g.createImageData(DIG_W, DIG_H);
    for (let y = 0; y < DIG_H; y++)
      for (let x = 0; x < DIG_W; x++) {
        const v = 0.25 + 0.5 * (y / DIG_H) + (bayer(x, y) - 0.5) * 0.2;
        const c = mix(hex('#03040a'), hex('#0b101b'), Math.max(0, Math.min(1, v)));
        img.data.set([...c, 255], (y * DIG_W + x) * 4);
      }
    g.putImageData(img, 0, 0);
  }

  /**
   * One frame. `at` is the cursor in art px (null when it's off the dig),
   * `firing` whether the beam is on.
   */
  frame(dt: number, t: number, tool: Tool, at: { x: number; y: number } | null, firing: boolean, scale: number) {
    const c = this.col.ctx, e = this.emit.ctx, l = this.light.ctx, dig = this.dig;
    c.clearRect(0, 0, DIG_W, DIG_H);
    e.clearRect(0, 0, DIG_W, DIG_H);
    l.globalCompositeOperation = 'source-over';
    l.fillStyle = '#000';
    l.fillRect(0, 0, DIG_W, DIG_H);
    e.globalCompositeOperation = l.globalCompositeOperation = 'lighter';
    // Work lamp over the dig, from the top left like the world's key light.
    l.globalAlpha = 0.55;
    l.drawImage(assets.light('#c8d8ff'), -DIG_W * 0.3, -DIG_H * 0.6, DIG_W * 1.5, DIG_H * 1.8);
    l.globalAlpha = 1;
    this.shake = Math.max(0, this.shake - dt * 10);
    const sh = this.shake ? Math.round((Math.random() - 0.5) * this.shake) : 0;
    for (const g of [c, e, l]) g.setTransform(1, 0, 0, 1, sh, 0);

    for (let i = 0; i < this.glow.length; i++) this.glow[i] = Math.max(0, this.glow[i] - dt * 1.2);
    this.drawFloor(c);
    // Back to front: a find goes in just before the row it starts on, so stone over it and in front covers it.
    for (let r = 0; r < ROWS; r++) {
      for (const f of dig.finds) if (f.y === r && f.state === 'buried') this.drawFind(f, t);
      for (let x = 0; x < COLS; x++) this.drawStack(x, r, t);
    }
    this.drawLifting(dt);
    if (this.scanT > 0) this.drawScan(t);
    if (at) this.drawBeam(tool, at, firing, t, dt);
    this.drawParts(dt);
    for (const g of [c, e, l]) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }
    this.post.render({ bg: this.bg.cv, col: this.col.cv, emit: this.emit.cv, light: this.light.cv, pw: this.canvas.width, ph: this.canvas.height, scale, fx: 0, fy: 0, time: t });
  }

  /** Bedrock, wherever the stone is cut through: dark, with faint seams. */
  private drawFloor(c: CanvasRenderingContext2D) {
    for (let y = 0; y < ROWS; y++)
      for (let x = 0; x < COLS; x++) {
        if (this.dig.layers(x, y)) continue;
        const [sx, sy] = this.cellTop(x, y, 0);
        for (let py = 0; py < RH; py++)
          for (let px = 0; px < CW; px++) {
            const v = 0.18 + hash2(sx + px, sy + py, 5) * 0.12 + (bayer(sx + px, sy + py) - 0.5) * 0.1;
            c.fillStyle = css(ROCK[Math.max(0, Math.min(ROCK.length - 1, Math.floor(v * ROCK.length)))]);
            c.fillRect(sx + px, sy + py, 1, 1);
          }
      }
  }

  /** A stack: lit top face, then its cut face down to the stack in front, banded by strata. */
  private drawStack(x: number, y: number, t: number) {
    const dig = this.dig, n = dig.layers(x, y);
    if (!n) return;
    const c = this.col.ctx, e = this.emit.ctx, stack = dig.cells[y * COLS + x], top = stack[n - 1], R = STONE_RAMP[top];
    const [sx, sy] = this.cellTop(x, y, n);
    const west = dig.layers(x - 1, y), east = dig.layers(x + 1, y), north = dig.layers(x, y - 1), south = dig.layers(x, y + 1);
    // Partly cut stone darkens toward its hp running out.
    const worn = 1 - dig.hp[y * COLS + x] / STONE[top].hp;
    for (let py = 0; py < RH; py++)
      for (let px = 0; px < CW; px++) {
        let v = 0.55 + (hash2(sx + px, sy + py, 9) - 0.5) * 0.18 - worn * 0.2;
        if (py === 0 && north < n) v += 0.25; // lit back edge
        if (px === 0 && west < n) v += 0.15;
        if (px === CW - 1 && east < n) v -= 0.2;
        if (west > n && px < 2) v -= 0.25; // shadow cast by a taller neighbour
        if (north > n && py < 2) v -= 0.2;
        const f = Math.max(0, Math.min(1, v)) * (R.length - 1), i = Math.floor(f);
        c.fillStyle = css(R[Math.min(R.length - 1, f - i > 0.5 + (bayer(sx + px, sy + py) - 0.5) * 0.5 ? i + 1 : i)]);
        c.fillRect(sx + px, sy + py, 1, 1);
      }
    if (top === 'obsidian' && hash2(x, y, 21) < 0.3) {
      // Glassy glints that catch the light now and then.
      const gx = sx + 1 + Math.floor(hash2(x, y, 22) * (CW - 2)), gy = sy + 1 + Math.floor(hash2(x, y, 23) * (RH - 2));
      e.globalAlpha = 0.35 + 0.35 * Math.sin(t * 2 + x * 1.7 + y);
      e.fillStyle = '#8a7dff';
      e.fillRect(gx, gy, 1, 1);
      e.globalAlpha = 1;
    }
    const heat = this.glow[y * COLS + x];
    if (heat > 0.02) {
      // Stone under the beam glows like molten rock.
      e.globalAlpha = Math.min(0.85, heat);
      e.fillStyle = heat > 0.6 ? '#ffd27a' : '#ff7a2a';
      e.fillRect(sx, sy, CW, RH);
      e.globalAlpha = 1;
    }
    // Cut face: one band per exposed layer, darker toward the bottom.
    if (n > south)
      for (let k = n - 1; k >= south; k--) {
        const FR = STONE_RAMP[stack[k]], y0 = sy + RH + (n - 1 - k) * LH;
        for (let py = 0; py < LH; py++)
          for (let px = 0; px < CW; px++) {
            const v = 0.3 - py * 0.04 - (n - 1 - k) * 0.04 + (hash2(sx + px, y0 + py, 4) - 0.5) * 0.1 + (py === 0 ? 0.06 : 0);
            c.fillStyle = css(FR[Math.max(0, Math.min(FR.length - 1, Math.round(v * (FR.length - 1))))]);
            c.fillRect(sx + px, y0 + py, 1, 1);
          }
        c.fillStyle = css(OUTLINE);
        c.fillRect(sx, y0 + LH - (k === south ? 1 : 0), CW, k === south ? 1 : 0);
      }
    // Dark outline where the stack drops away to the side.
    c.fillStyle = css(OUTLINE);
    if (west < n) c.fillRect(sx - 1, sy, 1, RH + (n - Math.max(west, south)) * LH);
    if (east < n) c.fillRect(sx + CW, sy, 1, RH + (n - Math.max(east, south)) * LH);
  }

  /** A find on the bedrock, fitted to its footprint, cracking as it loses integrity. */
  private drawFind(f: Find, t: number) {
    const c = this.col.ctx, e = this.emit.ctx, l = this.light.ctx, spr = itemSprite(f.kind);
    const [x0, y0] = this.cellTop(f.x, f.y, 0), w = f.w * CW, h = f.h * RH;
    // Its hollow in the bedrock.
    c.fillStyle = css(ROCK[0]);
    c.fillRect(x0, y0, w, h);
    const k = Math.min((w + 4) / spr.size, (h + 10) / spr.size), dw = Math.round(spr.size * k), dx = Math.round(x0 + (w - dw) / 2), dy = Math.round(y0 + h - dw * 0.8);
    c.drawImage(spr.color, dx, dy, dw, dw);
    const exp = this.dig.exposure(f);
    e.globalAlpha = 0.5 + 0.5 * exp;
    e.drawImage(spr.emit, dx, dy, dw, dw);
    e.globalAlpha = 1;
    if (exp > 0) {
      l.globalAlpha = 0.35 * exp * (0.8 + 0.2 * Math.sin(t * 3 + f.id));
      l.drawImage(assets.light(itemColor(f.kind)), x0 + w / 2 - 20, y0 + h / 2 - 20, 40, 40);
      l.globalAlpha = 1;
    }
    if (f.integrity < 1) {
      // Cracks spread from the middle as it takes damage, glowing hot at the tips.
      const n = Math.floor((1 - f.integrity) * 24), cx = x0 + w / 2, cy = y0 + h / 2;
      for (let i = 0; i < n; i++) {
        const a = hash2(f.id, i, 31) * Math.PI * 2, rr = (i / 24) * Math.max(w, h) * 0.6;
        const px = Math.round(cx + Math.cos(a) * rr), py = Math.round(cy + Math.sin(a) * rr * 0.7);
        c.fillStyle = css(OUTLINE);
        c.fillRect(px, py, 1, 1);
        if (i > n - 4) {
          e.fillStyle = css(C_AMBER);
          e.fillRect(px, py, 1, 1);
        }
      }
    }
  }

  /** Freed finds rise out of the dig with a sparkle, then fade into the hold. */
  private drawLifting(dt: number) {
    const c = this.col.ctx, e = this.emit.ctx, l = this.light.ctx;
    for (const [id, age] of this.lifting) {
      const f = this.dig.finds[id], a = age + dt;
      if (a > 1.4) {
        this.lifting.delete(id);
        continue;
      }
      this.lifting.set(id, a);
      const spr = itemSprite(f.kind, 0.35 + a * 2.5);
      const [x0, y0] = this.cellTop(f.x, f.y, 0), w = f.w * CW, h = f.h * RH;
      const k = Math.min((w + 4) / spr.size, (h + 10) / spr.size) * (1 + a * 0.3), dw = Math.round(spr.size * k);
      const rise = Math.min(1, a / 0.6) ** 0.5 * 14, fade = a < 0.9 ? 1 : 1 - (a - 0.9) / 0.5;
      const dx = Math.round(x0 + (w - dw) / 2), dy = Math.round(y0 + h - dw * 0.8 - rise);
      c.globalAlpha = e.globalAlpha = fade;
      c.drawImage(spr.color, dx, dy, dw, dw);
      e.drawImage(spr.emit, dx, dy, dw, dw);
      l.globalAlpha = 0.7 * fade;
      l.drawImage(assets.light(itemColor(f.kind)), dx + dw / 2 - 30, dy + dw / 2 - 30, 60, 60);
      c.globalAlpha = e.globalAlpha = l.globalAlpha = 1;
      if (Math.random() < dt * 30) {
        const life = 0.4 + Math.random() * 0.4;
        this.parts.push({ x: dx + Math.random() * dw, y: dy + Math.random() * dw, vx: 0, vy: -10 - Math.random() * 10, life, max: life, col: '#ffffff', glow: true, g: 0 });
      }
    }
  }

  /** Scanner sweep: buried finds show as pulsing outlines through the stone. */
  private drawScan(t: number) {
    const e = this.emit.ctx;
    e.globalAlpha = Math.min(1, this.scanT) * (0.5 + 0.3 * Math.sin(t * 10));
    e.fillStyle = BEAM;
    for (const f of this.dig.finds) {
      if (f.state !== 'buried') continue;
      const [x0, y0] = this.cellTop(f.x, f.y, 0), w = f.w * CW, h = f.h * RH;
      for (let x = 0; x < w; x += 2) {
        e.fillRect(x0 + x, y0, 1, 1);
        e.fillRect(x0 + x, y0 + h - 1, 1, 1);
      }
      for (let y = 0; y < h; y += 2) {
        e.fillRect(x0, y0 + y, 1, 1);
        e.fillRect(x0 + w - 1, y0 + y, 1, 1);
      }
    }
    e.globalAlpha = 1;
  }

  private drawBeam(tool: Tool, at: { x: number; y: number }, firing: boolean, t: number, dt: number) {
    const e = this.emit.ctx, l = this.light.ctx;
    const tx = Math.round(at.x), ty = Math.round(at.y);
    // Reticle: the beam's footprint on the stone.
    const rx = tool.radius * CW, ry = tool.radius * RH;
    e.globalAlpha = firing ? 0.5 : 0.35;
    this.warn = Math.max(0, this.warn - dt);
    e.strokeStyle = !this.dig.canFire || (this.warn > 0 && Math.floor(t * 16) % 2) ? '#ff5a70' : BEAM;
    e.lineWidth = 1;
    e.beginPath();
    e.ellipse(tx + 0.5, ty + 0.5, rx, ry, 0, 0, Math.PI * 2);
    e.stroke();
    e.globalAlpha = 1;
    if (!firing || !this.dig.canFire) return;
    // From the ship's emitter above the top edge, jittering slightly.
    const x0 = DIG_W / 2 + (tx - DIG_W / 2) * 0.35, y0 = -4, len = Math.hypot(tx - x0, ty - y0);
    for (let d = 0; d < len; d++) {
      const u = d / len, j = (hash2(Math.floor(d / 3), Math.floor(t * 30), 7) - 0.5) * (tool.id === 'cutter' ? 1.6 : 0.8);
      const px = Math.round(x0 + (tx - x0) * u + j), py = Math.round(y0 + (ty - y0) * u);
      e.globalAlpha = 0.5;
      e.fillStyle = BEAM;
      if (tool.id === 'cutter') e.fillRect(px - 1, py, 3, 1);
      e.globalAlpha = 1;
      e.fillStyle = '#ffffff';
      e.fillRect(px, py, 1, 1);
    }
    e.fillStyle = '#ffffff';
    e.fillRect(tx - 1, ty - 1, 3, 3);
    l.globalAlpha = 0.9;
    l.drawImage(assets.light('#ffb45a'), tx - 28, ty - 28, 56, 56);
    l.globalAlpha = 0.3;
    l.drawImage(assets.light(BEAM), x0 - 20, y0 - 10, 40, 40);
    l.globalAlpha = 1;
    // Sparks off the cut, and the odd puff of rock dust.
    if (Math.random() < dt * (tool.id === 'cutter' ? 60 : 30))
      for (let i = 0; i < 2; i++) {
        const life = 0.2 + Math.random() * 0.3;
        this.parts.push({ x: tx, y: ty, vx: (Math.random() - 0.5) * 90, vy: -20 - Math.random() * 60, life, max: life, col: Math.random() < 0.5 ? '#ffffff' : '#ffd27a', glow: true, g: 220 });
      }
  }

  private drawParts(dt: number) {
    const c = this.col.ctx, e = this.emit.ctx;
    for (const p of this.parts) {
      p.life -= dt;
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const g = p.glow ? e : c;
      g.globalAlpha = Math.min(1, (p.life / p.max) * 1.5);
      g.fillStyle = p.col;
      g.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
    }
    c.globalAlpha = e.globalAlpha = 1;
    this.parts = this.parts.filter((p) => p.life > 0 && p.y < DIG_H + 4);
  }
}
