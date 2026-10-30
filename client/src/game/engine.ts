import { BUILDABLE, FACTIONS, STRUCT, StructureKind, TileKind } from './defs';
import { HudState, TileSnap, toast } from './game';
import { CX, CY, neighbor, pick, RH, TW, tileX, tileY } from './hex';
import { Post } from './post';
import { assets, SOX, SOY, STAR_DOMAIN, TILE_PAD } from './sprites';
import { Store } from './store';
import { Chunk, CHUNK_PX_H, CHUNK_PX_W, CS_BITS, localIndex, pack } from './chunks';
import { KINDS, VOID } from './terrain';
import { progressOf, Structure } from './protocol';
import { ChunkMaps, OV_H, OV_W, WorldMap } from './render/maps';
import { hash2, smoothstep } from './rng';
import type { WorldView } from './WorldView';

interface Layer { cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D }
const layer = (): Layer => {
  const cv = document.createElement('canvas');
  return { cv, ctx: cv.getContext('2d')! };
};

interface Ship { f: number; x0: number; y0: number; x1: number; y1: number; t: number; dur: number; arc: number; trail: number[] }
interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; col: string }

const MAX_ZOOM = 7;
/** At or above this zoom, art pixels map 1:1 to buffer texels (crisp pixel art). */
const TACTICAL_ZOOM = 2;
/** Tiles fade out / map fades in across this zoom band. */
const MAP_FADE: [number, number] = [0.95, 0.75];

const tileSeed = (col: number, row: number) => hash2(row, col, 1);

export interface EngineStats { fps: number; tiles: number; zoom: number; lod: string }

export class Engine {
  private glc = document.createElement('canvas');
  private post: Post;
  private bg = layer();
  private col = layer();
  private emit = layer();
  private light = layer();
  private chunkMaps = new ChunkMaps();
  private worldMap: WorldMap;

  cam = { x: 0, y: 0, zoom: 3, tz: 3, vx: 0, vy: 0, gx: NaN, gy: NaN };
  debug = false;
  readonly stats: EngineStats = { fps: 0, tiles: 0, zoom: 3, lod: 'tactical' };
  private mouse = { x: 0, y: 0, inside: false, shift: false };
  private drag: null | { id: number; sx: number; sy: number; lx: number; ly: number; moved: boolean; button: number; lt: number } = null;
  private keys = new Set<string>();
  private hover: [number, number] | null = null;
  private selected: [number, number] | null = null;
  private buildMode: StructureKind | null = null;
  private ships: Ship[] = [];
  private shipSources: Structure[][] = [];
  private shipAcc = 1;
  private parts: Particle[] = [];
  private raf = 0;
  private last = 0;
  private syncAcc = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private hoverKey = '';
  private cleanup: (() => void)[] = [];

  constructor(private host: HTMLElement, private view: WorldView, private hud: Store<HudState>) {
    assets.init();
    this.worldMap = new WorldMap(view);
    this.glc.className = 'game-canvas';
    host.appendChild(this.glc);
    this.post = new Post(this.glc);
    const meta = view.meta!;
    const home = meta.homes[meta.player];
    this.cam.x = tileX(home.col, home.row) + CX;
    this.cam.y = tileY(home.row) + CY;
    // Deep-link: ?at=col,row&zoom=4 (or ?at=f2 for a faction's home).
    const q = new URLSearchParams(location.search);
    const at = q.get('at');
    if (at) {
      const h = at.startsWith('f') ? meta.homes[Number(at.slice(1))] : null;
      const [c, r] = h ? [h.col, h.row] : at.split(',').map(Number);
      if (Number.isFinite(c) && Number.isFinite(r)) {
        this.cam.x = tileX(c, r) + CX;
        this.cam.y = tileY(r) + CY;
        this.selected = [c, r];
      }
    }
    if (q.get('zoom')) this.cam.zoom = this.cam.tz = this.clampZoom(Number(q.get('zoom')) || 3);
    this.debug = q.has('debug');
    this.bindInput();
    this.raf = requestAnimationFrame(this.frame);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.cleanup.forEach((f) => f());
    this.post.dispose();
    this.glc.remove();
  }

  // ---------------------------------------------------------------- public API (UI)
  setBuildMode(kind: StructureKind | null) {
    this.buildMode = kind;
    this.hoverKey = '';
    this.hud.set({ buildMode: kind });
    // Placing needs tile-level detail; pull the camera in if we're on the map.
    if (kind && this.cam.tz < TACTICAL_ZOOM) this.cam.tz = 3;
  }

  centerOn(wx: number, wy: number) {
    this.cam.gx = wx;
    this.cam.gy = wy;
  }

  goHome() {
    const m = this.view.meta!, h = m.homes[m.player];
    this.centerOn(tileX(h.col, h.row) + CX, tileY(h.row) + CY);
  }

  focusTile(col: number, row: number) {
    this.centerOn(tileX(col, row) + CX, tileY(row) + CY);
    if (this.cam.tz < TACTICAL_ZOOM) this.cam.tz = 3;
    this.select([col, row]);
  }

  /** Smallest zoom that still fits the whole world on screen. */
  get minZoom() {
    const R = this.view.params.radiusPx;
    return Math.max(0.02, Math.min(this.host.clientWidth, this.host.clientHeight) / (2.1 * R));
  }

  private clampZoom(z: number) {
    return Math.max(this.minZoom, Math.min(MAX_ZOOM, z));
  }

  setZoom(z: number) {
    this.cam.tz = this.clampZoom(z);
  }

  zoomBy(factor: number) {
    this.setZoom(this.cam.tz * factor);
  }

  toggleDebug() {
    this.debug = !this.debug;
  }

  async demolishSelected() {
    if (!this.selected) return;
    const r = await this.view.demolish(...this.selected);
    if (!r.ok) toast(r.reason!, 'bad');
  }

  getView() {
    const w = this.host.clientWidth / this.cam.zoom, h = this.host.clientHeight / this.cam.zoom;
    return { x: this.cam.x - w / 2, y: this.cam.y - h / 2, w, h };
  }

  /** World-scale map image and the world rect it covers (minimap). */
  minimap() {
    return { canvas: this.worldMap.composite, rect: this.worldMap.rect };
  }

  // ---------------------------------------------------------------- input
  private bindInput() {
    const el = this.glc;
    const on = <K extends keyof HTMLElementEventMap>(t: HTMLElement | Window, k: K, f: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions) => {
      t.addEventListener(k, f as EventListener, o);
      this.cleanup.push(() => t.removeEventListener(k, f as EventListener, o));
    };
    const local = (e: PointerEvent | WheelEvent) => {
      const r = el.getBoundingClientRect();
      this.mouse.x = e.clientX - r.left;
      this.mouse.y = e.clientY - r.top;
      this.mouse.inside = true;
      this.mouse.shift = e.shiftKey;
    };

    on(el, 'contextmenu', (e) => e.preventDefault());
    on(el, 'pointerdown', (e) => {
      local(e);
      el.setPointerCapture(e.pointerId);
      this.drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, button: e.button, lt: performance.now() };
      this.cam.vx = this.cam.vy = 0;
      this.cam.gx = NaN;
    });
    on(el, 'pointermove', (e) => {
      local(e);
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.lx, dy = e.clientY - d.ly;
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 5) d.moved = true;
      if (d.moved) {
        const now = performance.now(), dt = Math.max(1, now - d.lt) / 1000;
        this.cam.x -= dx / this.cam.zoom;
        this.cam.y -= dy / this.cam.zoom;
        this.cam.vx = this.cam.vx * 0.6 + (-dx / this.cam.zoom / dt) * 0.4;
        this.cam.vy = this.cam.vy * 0.6 + (-dy / this.cam.zoom / dt) * 0.4;
        d.lt = now;
      }
      d.lx = e.clientX;
      d.ly = e.clientY;
    });
    const up = (e: PointerEvent) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      this.drag = null;
      if (!d.moved) {
        this.cam.vx = this.cam.vy = 0;
        if (d.button === 0) this.click();
        else if (d.button === 2 && this.buildMode) this.setBuildMode(null);
      } else if (performance.now() - d.lt > 80) this.cam.vx = this.cam.vy = 0;
    };
    on(el, 'pointerup', up);
    on(el, 'pointercancel', up);
    on(el, 'pointerleave', () => { if (!this.drag) this.mouse.inside = false; });
    on(el, 'wheel', (e) => {
      e.preventDefault();
      local(e);
      this.setZoom(this.cam.tz * Math.exp(-e.deltaY * 0.0014));
    }, { passive: false });

    on(window, 'keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      this.mouse.shift = e.shiftKey;
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
        this.keys.add(k);
        this.cam.gx = NaN;
        e.preventDefault();
      } else if (k === 'escape') {
        if (this.buildMode) this.setBuildMode(null);
        else this.select(null);
      } else if (k === 'f3') {
        e.preventDefault();
        this.toggleDebug();
      } else if (k === 'h') this.goHome();
      else if (k === '=' || k === '+') this.zoomBy(1.5);
      else if (k === '-') this.zoomBy(1 / 1.5);
      else if (k === 'm') this.setZoom(this.cam.tz < 1 ? 3 : this.minZoom);
      else if (k >= '1' && k <= '9') {
        const def = BUILDABLE[Number(k) - 1];
        if (def) this.setBuildMode(this.buildMode === def.kind ? null : def.kind);
      }
    });
    on(window, 'keyup', (e) => {
      this.keys.delete(e.key.toLowerCase());
      this.mouse.shift = e.shiftKey;
    });
    on(window, 'blur', () => this.keys.clear());
  }

  private async click() {
    const h = this.hover;
    if (this.buildMode) {
      if (!h) return;
      const kind = this.buildMode;
      const pre = this.view.canBuild(kind, h[0], h[1]);
      if (!pre.ok) return toast(pre.reason!, 'bad');
      if (!this.mouse.shift) this.setBuildMode(null);
      const r = await this.view.build(kind, h[0], h[1]);
      if (!r.ok) return toast(r.reason!, 'bad');
      toast(`${STRUCT[kind].name}: construction started`, 'good');
      this.select(h);
      return;
    }
    this.select(h);
  }

  private select(t: [number, number] | null) {
    this.selected = t;
    this.hud.set({ selected: t ? this.snap(t[0], t[1], false) : null });
  }

  private snap(col: number, row: number, withBuild: boolean): TileSnap | null {
    const kind = this.view.kind(col, row);
    if (!kind) return null;
    const s = this.view.structure(col, row);
    const snap: TileSnap = {
      col, row, kind, variant: this.view.chunkAt(col, row)!.variant[localIndex(col, row)], owner: this.view.owner(col, row),
      structure: s ? { kind: s.kind, progress: progressOf(s, this.view.now()), level: s.level, owner: s.owner, finishAt: s.finishAt } : null,
      known: this.view.known(col, row),
    };
    if (withBuild && this.buildMode) Object.assign(snap, this.view.canBuild(this.buildMode, col, row));
    return snap;
  }

  // ---------------------------------------------------------------- loop
  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, (now - (this.last || now)) / 1000);
    this.last = now;
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      this.stats.fps = Math.round(this.fpsFrames / this.fpsAcc);
      this.fpsAcc = this.fpsFrames = 0;
    }
    this.updateCamera(dt);
    this.view.update(this.getView(), 3);
    this.worldMap.update(2);
    this.updateHover();
    this.updateShips(dt);
    this.render(now / 1000, dt);
    this.syncHud(dt);
  };

  private updateCamera(dt: number) {
    const c = this.cam;
    const speed = 900 / c.zoom;
    let kx = 0, ky = 0;
    if (this.keys.has('a') || this.keys.has('arrowleft')) kx--;
    if (this.keys.has('d') || this.keys.has('arrowright')) kx++;
    if (this.keys.has('w') || this.keys.has('arrowup')) ky--;
    if (this.keys.has('s') || this.keys.has('arrowdown')) ky++;
    c.x += kx * speed * dt;
    c.y += ky * speed * dt;

    if (!this.drag) {
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      const damp = Math.exp(-dt * 5);
      c.vx *= damp;
      c.vy *= damp;
    }
    if (!Number.isNaN(c.gx)) {
      const k = 1 - Math.exp(-dt * 7);
      c.x += (c.gx - c.x) * k;
      c.y += (c.gy - c.y) * k;
      if (Math.hypot(c.gx - c.x, c.gy - c.y) < 0.5) c.gx = c.gy = NaN;
    }

    const prev = c.zoom;
    // Zoom eases in log space so far-out zooming feels as smooth as close-in.
    c.zoom = Math.exp(Math.log(c.zoom) + (Math.log(c.tz) - Math.log(c.zoom)) * (1 - Math.exp(-dt * 14)));
    if (Math.abs(c.tz - c.zoom) < 0.001 * c.tz) c.zoom = c.tz;
    if (c.zoom !== prev && this.mouse.inside) {
      // Keep the world point under the cursor fixed while zooming.
      const mx = this.mouse.x - this.host.clientWidth / 2, my = this.mouse.y - this.host.clientHeight / 2;
      c.x += mx / prev - mx / c.zoom;
      c.y += my / prev - my / c.zoom;
    }
    const R = this.view.params.radiusPx;
    c.x = Math.max(-R, Math.min(R, c.x));
    c.y = Math.max(-R, Math.min(R, c.y));
  }

  private updateHover() {
    const { cam, mouse } = this;
    const wx = cam.x + (mouse.x - this.host.clientWidth / 2) / cam.zoom;
    const wy = cam.y + (mouse.y - this.host.clientHeight / 2) / cam.zoom;
    const p = mouse.inside && !this.drag?.moved ? pick(wx, wy) : null;
    const k = p && this.view.kind(p[0], p[1]);
    this.hover = k && k !== 'void' ? p : null;
    const key = this.hover ? `${this.hover}|${this.buildMode}|${this.view.chunkAt(...this.hover)!.version}` : '';
    if (key !== this.hoverKey) {
      this.hoverKey = key;
      this.hud.set({ hover: this.hover ? this.snap(this.hover[0], this.hover[1], true) : null });
    }
  }

  private syncHud(dt: number) {
    this.syncAcc += dt;
    if (this.syncAcc < 0.2) return;
    this.syncAcc = 0;
    this.hud.set({
      zoom: this.cam.tz,
      selected: this.selected ? this.snap(this.selected[0], this.selected[1], false) : null,
      hover: this.hover ? this.snap(this.hover[0], this.hover[1], true) : null,
    });
  }

  // ---------------------------------------------------------------- ships & particles
  private updateShips(dt: number) {
    // Re-gather launch sites about once a second, and only near the camera.
    this.shipAcc += dt;
    if (this.shipAcc > 1) {
      this.shipAcc = 0;
      const v = this.getView(), now = this.view.now();
      this.shipSources = FACTIONS.map(() => []);
      for (const s of this.view.structures.values()) {
        if (progressOf(s, now) < 1) continue;
        const x = tileX(s.col, s.row), y = tileY(s.row);
        if (x < v.x - 400 || x > v.x + v.w + 400 || y < v.y - 400 || y > v.y + v.h + 400) continue;
        this.shipSources[s.owner].push(s);
      }
    }
    if (this.cam.zoom >= 1)
      FACTIONS.forEach((f) => {
        const mine = this.shipSources[f.id] ?? [];
        const bays = mine.filter((s) => s.kind === 'dronebay' || s.kind === 'nexus');
        const cap = Math.min(10, bays.length * 2);
        if (!bays.length || mine.length < 2 || this.ships.filter((s) => s.f === f.id).length >= cap || Math.random() > dt * 1.5) return;
        const a = bays[Math.floor(Math.random() * bays.length)];
        let b = a;
        while (b === a) b = mine[Math.floor(Math.random() * mine.length)];
        const [x0, y0] = this.structTop(a), [x1, y1] = this.structTop(b);
        const dist = Math.hypot(x1 - x0, y1 - y0);
        if (dist > 900) return;
        this.ships.push({ f: f.id, x0, y0, x1, y1, t: 0, dur: 0.8 + dist / 55, arc: Math.min(40, dist * 0.22), trail: [] });
      });
    this.ships = this.ships.filter((s) => (s.t += dt) < s.dur);

    for (const p of this.parts) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    this.parts = this.parts.filter((p) => p.life > 0);
  }

  private structTop(s: Structure): [number, number] {
    return [tileX(s.col, s.row) + CX, tileY(s.row) + CY - 18];
  }

  // ---------------------------------------------------------------- render
  private render(t: number, dt: number) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = this.host.clientWidth, ch = this.host.clientHeight;
    const pw = Math.max(1, Math.round(cw * dpr)), ph = Math.max(1, Math.round(ch * dpr));
    if (this.glc.width !== pw || this.glc.height !== ph) {
      this.glc.width = pw;
      this.glc.height = ph;
    }
    const zoom = this.cam.zoom;
    // Device px per buffer texel. Never below TACTICAL_ZOOM, so zoomed out the
    // buffer stays small and the world is drawn scaled by k instead.
    const bufScale = Math.max(zoom, TACTICAL_ZOOM) * dpr;
    const k = (zoom * dpr) / bufScale;
    const vw = pw / (zoom * dpr), vh = ph / (zoom * dpr);
    const ox0 = this.cam.x - vw / 2, oy0 = this.cam.y - vh / 2;
    let ox = ox0, oy = oy0, fx = 0, fy = 0;
    if (k === 1) {
      // Integer origin + fractional shift in the shader: crisp pixels, smooth pan.
      ox = Math.floor(ox0);
      oy = Math.floor(oy0);
      fx = ox0 - ox;
      fy = oy0 - oy;
    }
    const lw = Math.ceil(pw / bufScale) + 2, lh = Math.ceil(ph / bufScale) + 2;
    for (const L of [this.bg, this.col, this.emit, this.light]) {
      if (L.cv.width !== lw || L.cv.height !== lh) {
        L.cv.width = lw;
        L.cv.height = lh;
      }
      L.ctx.imageSmoothingEnabled = k < 1;
      L.ctx.globalAlpha = 1;
      L.ctx.globalCompositeOperation = 'source-over';
      L.ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    this.light.ctx.imageSmoothingEnabled = true;
    this.drawBackground(ox * k, oy * k, lw, lh, t);
    this.drawWorld(ox, oy, k, lw, lh, t, dt);
    this.post.render({ bg: this.bg.cv, col: this.col.cv, emit: this.emit.cv, light: this.light.cv, pw, ph, scale: bufScale, fx, fy, time: t });
  }

  private drawBackground(ox: number, oy: number, lw: number, lh: number, t: number) {
    const g = this.bg.ctx;
    g.fillStyle = '#03040a';
    g.fillRect(0, 0, lw, lh);
    // Nebula drawn at 2x, mirror-tiled (every other tile flipped) so the edges
    // always match and it covers a world of any size without seams.
    const neb = assets.nebula, P = 0.18, w2 = neb.width * 2, h2 = neb.height * 2;
    const sx = ox * P, sy = oy * P;
    const i0 = Math.floor(sx / w2), j0 = Math.floor(sy / h2);
    for (let i = i0; i * w2 - sx < lw; i++)
      for (let j = j0; j * h2 - sy < lh; j++) {
        const fx = i & 1 ? -1 : 1, fy = j & 1 ? -1 : 1;
        g.setTransform(fx, 0, 0, fy, Math.round(i * w2 - sx) + (fx < 0 ? w2 : 0), Math.round(j * h2 - sy) + (fy < 0 ? h2 : 0));
        g.drawImage(neb, 0, 0, w2, h2);
      }
    g.setTransform(1, 0, 0, 1, 0, 0);

    const D = STAR_DOMAIN;
    g.fillStyle = '#dfe9ff';
    for (const layer of assets.stars) {
      for (const s of layer.list) {
        const sx = (((s.x - ox * layer.p) % D) + D) % D, sy = (((s.y - oy * layer.p) % D) + D) % D;
        if (sx >= lw || sy >= lh) continue;
        g.globalAlpha = s.b * (0.7 + 0.3 * Math.sin(t * 1.7 + s.ph));
        g.fillRect(sx | 0, sy | 0, 1, 1);
        if (s.big) {
          g.globalAlpha *= 0.45;
          g.fillRect((sx | 0) - 1, sy | 0, 3, 1);
          g.fillRect(sx | 0, (sy | 0) - 1, 1, 3);
        }
      }
    }
    g.globalAlpha = 1;
  }

  private drawWorld(ox: number, oy: number, k: number, lw: number, lh: number, t: number, dt: number) {
    const c = this.col.ctx, e = this.emit.ctx, l = this.light.ctx;
    const zoom = this.cam.zoom;
    c.clearRect(0, 0, lw, lh);
    e.clearRect(0, 0, lw, lh);
    l.fillStyle = '#000';
    l.fillRect(0, 0, lw, lh);
    const mapA = smoothstep(MAP_FADE[0], MAP_FADE[1], zoom);
    if (mapA > 0) {
      // The map is a flat chart: lift it out of the dark ambient.
      l.fillStyle = `rgba(95,100,115,${mapA})`;
      l.fillRect(0, 0, lw, lh);
    }
    for (const g of [c, e, l]) g.setTransform(k, 0, 0, k, -ox * k, -oy * k);
    e.globalCompositeOperation = 'lighter';
    l.globalCompositeOperation = 'lighter';

    const wx1 = ox + lw / k, wy1 = oy + lh / k;
    this.stats.zoom = zoom;
    this.stats.lod = zoom >= TACTICAL_ZOOM ? 'tactical' : zoom > MAP_FADE[1] ? 'tactical (scaled)' : this.view.detail ? 'chunk map' : 'world map';
    this.stats.tiles = 0;
    if (zoom > MAP_FADE[1]) this.drawTiles(ox, oy, wx1, wy1, t, dt);
    if (mapA > 0) this.drawMaps(ox, oy, wx1, wy1, mapA);
    if (zoom >= 1) {
      this.drawShips(c, e, l);
      for (const p of this.parts) {
        e.globalAlpha = Math.min(1, (p.life / p.max) * 1.6);
        e.fillStyle = p.col;
        e.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
      }
      e.globalAlpha = 1;
    }
    this.drawOverlays(t, k);
    if (this.debug) this.drawDebug(ox, oy, wx1, wy1, k);
  }

  private drawTiles(ox: number, oy: number, wx1: number, wy1: number, t: number, dt: number) {
    const c = this.col.ctx, e = this.emit.ctx, l = this.light.ctx;
    const view = this.view, now = view.now();
    const r0 = Math.floor((oy - 24) / RH), r1 = Math.floor((wy1 + 48) / RH);
    const c0 = Math.floor((ox - 48) / TW), c1 = Math.floor((wx1 + 16) / TW);
    const pulse = 0.78 + 0.22 * Math.sin(t * 2.2);
    const build = this.buildMode;
    let lcx = NaN, lcy = NaN, chunk: Chunk | undefined;
    const chunkFor = (col: number, row: number) => {
      const cx = col >> CS_BITS, cy = row >> CS_BITS;
      if (cx !== lcx || cy !== lcy) {
        lcx = cx;
        lcy = cy;
        chunk = view.chunks.get(pack(cx, cy));
      }
      return chunk && chunk.terrainReady ? chunk : undefined;
    };

    for (let r = r0; r <= r1; r++) {
      for (let col = c0; col <= c1; col++) {
        const ch = chunkFor(col, r);
        if (!ch) continue;
        const i = localIndex(col, r), kid = ch.kind[i];
        if (kid === VOID) continue;
        this.stats.tiles++;
        const kind = KINDS[kid] as TileKind;
        const x = tileX(col, r), y = tileY(r);
        const spr = assets.tile(kind, ch.variant[i]);
        c.drawImage(spr.color, x, y - TILE_PAD);
        if (spr.emit) {
          e.globalAlpha = kind === 'crystal' || kind === 'gas' ? 0.6 + 0.4 * Math.sin(t * 1.6 + tileSeed(col, r) * 40) : 1;
          e.drawImage(spr.emit, x, y - TILE_PAD);
          e.globalAlpha = 1;
        }
        if (kind === 'crystal' || kind === 'gas') {
          l.globalAlpha = 0.32;
          l.drawImage(assets.light(kind === 'crystal' ? '#4fe6ff' : '#b65cff'), x + CX - 22, y + CY - 22, 44, 44);
          if (Math.random() < dt * (kind === 'gas' ? 1.2 : 0.8)) this.spawnTileParticle(kind, x, y);
        }
        const o = ch.owner[i];
        if (o >= 0) {
          l.globalAlpha = 0.09;
          l.drawImage(assets.fill(FACTIONS[o].color), x, y);
          e.globalAlpha = 0.7 * pulse;
          for (let d = 0; d < 6; d++) if (view.owner(...neighbor(col, r, d)) !== o) e.drawImage(assets.edges[o][d], x, y);
        }
        if (build && view.canBuild(build, col, r).ok) {
          l.globalAlpha = 0.28 + 0.1 * Math.sin(t * 4);
          l.drawImage(assets.fill('#5cff9d'), x, y);
        }
        l.globalAlpha = 1;
        e.globalAlpha = 1;
      }
      for (let col = c0; col <= c1; col++) {
        const ch = chunkFor(col, r);
        const s = ch?.structures.get(localIndex(col, r));
        if (s) this.drawStructure(s, tileX(col, r), tileY(r), t, now);
      }
    }
  }

  private drawMaps(ox: number, oy: number, wx1: number, wy1: number, alpha: number) {
    const c = this.col.ctx, e = this.emit.ctx;
    c.globalAlpha = alpha;
    e.globalAlpha = alpha;
    // Whole-world layer first: it covers everything we aren't streaming.
    const wm = this.worldMap, R = wm.rect;
    // Nearest-neighbour when enlarging (chunky map pixels), smooth only when shrinking.
    const k = this.cam.zoom / Math.max(this.cam.zoom, TACTICAL_ZOOM);
    const smooth = (s: number) => {
      c.imageSmoothingEnabled = e.imageSmoothingEnabled = s < 1;
    };
    // Coarse terrain only where chunk maps can't cover: far out or detail off.
    // Mid-zoom it would show as blocky rectangles under the chunk maps.
    if (!this.view.detail || this.cam.zoom < 0.4) {
      smooth((R.w * k) / WorldMap.RES);
      c.drawImage(wm.terrain, R.x, R.y, R.w, R.h);
    }
    const ov = this.view.overview;
    if (ov) {
      c.globalAlpha = alpha * 0.55;
      c.drawImage(wm.owners, ov.x0, ov.y0, ov.w * ov.cell, ov.h * ov.cell);
      c.globalAlpha = alpha;
      if (!this.view.detail) e.drawImage(wm.borders, ov.x0, ov.y0, ov.w * ov.cell, ov.h * ov.cell);
    }
    // Then baked per-chunk maps where we have live detail.
    if (this.view.detail) {
      const visible: Chunk[] = [];
      const cx0 = Math.floor(ox / CHUNK_PX_W) - 1, cx1 = Math.floor(wx1 / CHUNK_PX_W);
      const cy0 = Math.floor(oy / CHUNK_PX_H) - 1, cy1 = Math.floor(wy1 / CHUNK_PX_H);
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++) {
          const ch = this.view.chunks.get(pack(cx, cy));
          if (ch) visible.push(ch);
        }
      this.chunkMaps.update(this.view, visible, 3);
      const sw = (OV_W * TW) / 3, sh = (OV_H * RH) / 2;
      smooth((TW / 3) * k);
      for (const ch of visible) {
        const b = this.chunkMaps.get(ch);
        if (!b) continue;
        c.drawImage(b.color, ch.cx * CHUNK_PX_W, ch.cy * CHUNK_PX_H, sw, sh);
        e.drawImage(b.emit, ch.cx * CHUNK_PX_W, ch.cy * CHUNK_PX_H, sw, sh);
      }
    }
    c.globalAlpha = 1;
    e.globalAlpha = 1;
    c.imageSmoothingEnabled = e.imageSmoothingEnabled = k < 1;
  }

  private spawnTileParticle(kind: TileKind, x: number, y: number) {
    if (this.parts.length > 400) return;
    const px = x + 8 + Math.random() * 16, py = y + 8 + Math.random() * 12;
    if (kind === 'gas') this.parts.push({ x: px, y: py, vx: (Math.random() - 0.5) * 4, vy: -6 - Math.random() * 6, life: 2.4, max: 2.4, col: '#c57bff' });
    else this.parts.push({ x: px, y: py - 6, vx: 0, vy: -2, life: 0.6, max: 0.6, col: '#d6fffd' });
  }

  private drawStructure(s: Structure, x: number, y: number, t: number, now: number) {
    const c = this.col.ctx, e = this.emit.ctx, l = this.light.ctx;
    const spr = assets.structure(s.kind, s.owner);
    const f = FACTIONS[s.owner];
    const sx = x + SOX, sy = y + SOY;
    const seed = tileSeed(s.col, s.row);
    const progress = progressOf(s, now);

    if (progress < 1) {
      // Hologram fabrication: solid from the ground up, scanning beam at the build line.
      const cut = Math.round(60 * (1 - progress));
      if (cut < 60) c.drawImage(spr.color, 0, cut, 40, 60 - cut, sx, sy + cut, 40, 60 - cut);
      e.globalAlpha = 0.45 + 0.15 * Math.sin(t * 9 + seed * 10);
      if (cut > 0) e.drawImage(spr.holo, 0, 0, 40, cut, sx, sy, 40, cut);
      e.globalAlpha = 0.9;
      e.fillStyle = f.color;
      e.fillRect(sx + 4, sy + cut, 32, 1);
      e.globalAlpha = 1;
      l.globalAlpha = 0.4;
      l.drawImage(assets.light(f.color), x + CX - 28, y + CY - 34, 56, 56);
      l.globalAlpha = 1;
      return;
    }

    c.drawImage(spr.color, sx, sy);
    e.drawImage(spr.emit, sx, sy);
    for (const [bx, by] of spr.beacons) {
      if (Math.sin(t * 3 + seed * 20) <= 0.55) continue;
      e.fillStyle = '#ffffff';
      e.fillRect(sx + bx, sy + by, 1, 1);
      e.globalAlpha = 0.6;
      e.fillStyle = f.color;
      e.fillRect(sx + bx - 1, sy + by, 3, 1);
      e.fillRect(sx + bx, sy + by - 1, 1, 3);
      e.globalAlpha = 1;
    }

    // Specular sweep: a band of light glides over the metal now and then.
    const ph = (t * 0.16 + seed * 3) % 1;
    if (ph < 0.14) {
      const bx = sx - 30 + (ph / 0.14) * 90;
      e.save();
      e.beginPath();
      e.moveTo(bx, sy);
      e.lineTo(bx + 7, sy);
      e.lineTo(bx - 23, sy + 60);
      e.lineTo(bx - 30, sy + 60);
      e.closePath();
      e.clip();
      e.globalAlpha = 0.85;
      e.drawImage(spr.shine, sx, sy);
      e.restore();
    }

    if (s.kind === 'shield') {
      e.globalAlpha = 0.32 + 0.1 * Math.sin(t * 2 + seed * 6);
      e.drawImage(assets.domes[s.owner], x + CX - 23, y + CY - 30);
      e.globalAlpha = 1;
    }

    const R = STRUCT[s.kind].light;
    l.globalAlpha = 0.5;
    l.drawImage(assets.light(f.color), x + CX - R, y + CY - 10 - R, R * 2, R * 2);
    l.globalAlpha = 1;
  }

  private drawShips(c: CanvasRenderingContext2D, e: CanvasRenderingContext2D, l: CanvasRenderingContext2D) {
    for (const s of this.ships) {
      const k = s.t / s.dur, p = k * k * (3 - 2 * k);
      const x = Math.round(s.x0 + (s.x1 - s.x0) * p);
      const y = Math.round(s.y0 + (s.y1 - s.y0) * p - Math.sin(Math.PI * p) * s.arc);
      s.trail.push(x, y);
      if (s.trail.length > 20) s.trail.splice(0, 2);
      const col = FACTIONS[s.f].color;
      e.fillStyle = col;
      for (let i = 0; i < s.trail.length - 2; i += 2) {
        e.globalAlpha = (i / s.trail.length) * 0.55;
        e.fillRect(s.trail[i], s.trail[i + 1], 1, 1);
      }
      const dir = s.x1 >= s.x0 ? 1 : -1;
      c.fillStyle = '#8698b4';
      c.fillRect(x - 1, y, 3, 1);
      c.fillStyle = '#2f3c54';
      c.fillRect(x - 1, y + 1, 3, 1);
      e.globalAlpha = 1;
      e.fillRect(x - dir * 2, y, 1, 1);
      e.fillStyle = '#ffffff';
      e.fillRect(x + dir, y, 1, 1);
      l.globalAlpha = 0.35;
      l.drawImage(assets.light(col), x - 8, y - 8, 16, 16);
      l.globalAlpha = 1;
    }
    e.globalAlpha = 1;
  }

  private drawOverlays(t: number, k: number) {
    const e = this.emit.ctx, l = this.light.ctx;
    const me = FACTIONS[this.view.meta!.player];
    if (this.selected) {
      const [col, row] = this.selected;
      const x = tileX(col, row), y = tileY(row);
      e.globalAlpha = 0.75 + 0.25 * Math.sin(t * 5);
      e.drawImage(assets.outline(me.color), x, y);
      if (k < 1) {
        // Zoomed out: a ring that stays readable at any scale.
        e.strokeStyle = me.color;
        e.lineWidth = 2 / k;
        e.beginPath();
        e.arc(x + CX, y + CY, (10 + 4 * Math.sin(t * 4)) / k, 0, Math.PI * 2);
        e.stroke();
      } else {
        const tall = this.view.structure(col, row) ? 40 : 6;
        e.globalAlpha = 1;
        e.drawImage(assets.chevrons[this.view.meta!.player], x + CX - 3, y + CY - tall - 8 + Math.round(Math.sin(t * 4) * 2));
      }
      e.globalAlpha = 1;
    }
    if (this.hover && k > 0.4) {
      const [col, row] = this.hover;
      const x = tileX(col, row), y = tileY(row);
      l.globalAlpha = 0.22;
      l.drawImage(assets.fill('#ffffff'), x, y);
      l.globalAlpha = 1;
      if (this.buildMode) {
        const ok = this.view.canBuild(this.buildMode, col, row).ok;
        e.globalAlpha = 0.95;
        e.drawImage(assets.outline(ok ? '#5cff9d' : '#ff4f6a'), x, y);
        if (!this.view.structure(col, row)) {
          e.globalAlpha = ok ? 0.75 : 0.35;
          e.drawImage(assets.structure(this.buildMode, this.view.meta!.player).holo, x + SOX, y + SOY);
        }
        e.globalAlpha = 1;
      } else {
        e.globalAlpha = 0.55;
        e.drawImage(assets.outline('#dff6ff'), x, y);
        e.globalAlpha = 1;
      }
    }
  }

  /** F3: chunk grid coloured by stream state, like Minecraft's chunk borders. */
  private drawDebug(ox: number, oy: number, wx1: number, wy1: number, k: number) {
    const e = this.emit.ctx;
    e.lineWidth = 1 / k;
    for (const ch of this.view.chunks.values()) {
      const x = ch.cx * CHUNK_PX_W, y = ch.cy * CHUNK_PX_H;
      if (x > wx1 || y > wy1 || x + CHUNK_PX_W < ox || y + CHUNK_PX_H < oy) continue;
      const live = this.view.isSubscribed(ch.key);
      e.strokeStyle = !ch.terrainReady ? '#ff4f6a' : live && ch.stateReady ? '#5cff9d' : live ? '#ffc35c' : '#4b5b78';
      // Emissive feeds bloom, so keep debug lines faint or they flare across the screen.
      e.globalAlpha = 0.22;
      e.strokeRect(x + 0.5 / k, y + 0.5 / k, CHUNK_PX_W - 1 / k, CHUNK_PX_H - 1 / k);
    }
    e.globalAlpha = 1;
  }
}

