import { BUILDABLE, FACTIONS, PLAYER, STRUCT, StructureKind, TileKind } from './defs';
import { HudState, TileSnap, toast } from './game';
import { CX, CY, neighbor, pick, RH, TW, tileX, tileY } from './hex';
import { Post } from './post';
import { assets, SOX, SOY, STAR_DOMAIN, TILE_PAD } from './sprites';
import { Store } from './store';
import { Structure, World } from './world';

interface Layer { cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D }
const layer = (): Layer => {
  const cv = document.createElement('canvas');
  return { cv, ctx: cv.getContext('2d')! };
};

interface Ship { f: number; x0: number; y0: number; x1: number; y1: number; t: number; dur: number; arc: number; trail: number[] }
interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; col: string }

const MIN_ZOOM = 2, MAX_ZOOM = 7;
const MINI_COLORS: Record<TileKind, string> = {
  void: '', plate: '#2b3447', rock: '#2a2329', ore: '#5e3419', crystal: '#145d68', ice: '#36577a', gas: '#3e2352', ruin: '#33272a',
};

export class Engine {
  private glc = document.createElement('canvas');
  private post: Post;
  private bg = layer();
  private col = layer();
  private emit = layer();
  private light = layer();

  cam = { x: 0, y: 0, zoom: 3, tz: 3, vx: 0, vy: 0, gx: NaN, gy: NaN };
  private mouse = { x: 0, y: 0, inside: false, shift: false };
  private drag: null | { id: number; sx: number; sy: number; lx: number; ly: number; moved: boolean; button: number; lt: number } = null;
  private keys = new Set<string>();
  private hover: [number, number] | null = null;
  private selected: [number, number] | null = null;
  private buildMode: StructureKind | null = null;
  private ships: Ship[] = [];
  private parts: Particle[] = [];
  private raf = 0;
  private last = 0;
  private syncAcc = 0;
  private hoverKey = '';
  private mini: { cv: HTMLCanvasElement; v: number } | null = null;
  private cleanup: (() => void)[] = [];

  constructor(private host: HTMLElement, private world: World, private hud: Store<HudState>) {
    assets.init();
    this.glc.className = 'game-canvas';
    host.appendChild(this.glc);
    this.post = new Post(this.glc);
    const home = world.homes[PLAYER];
    this.cam.x = tileX(home.col, home.row) + CX;
    this.cam.y = tileY(home.row) + CY;
    // Deep-link: ?at=col,row&zoom=4 (or ?at=f2 for a faction's home).
    const q = new URLSearchParams(location.search);
    const at = q.get('at');
    if (at) {
      const h = at.startsWith('f') ? world.homes[Number(at.slice(1))] : null;
      const [c, r] = h ? [h.col, h.row] : at.split(',').map(Number);
      if (Number.isFinite(c) && Number.isFinite(r)) { this.cam.x = tileX(c, r) + CX; this.cam.y = tileY(r) + CY; }
    }
    if (q.get('zoom')) this.cam.zoom = this.cam.tz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(q.get('zoom')) || 3));
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
  }

  centerOn(wx: number, wy: number) {
    this.cam.gx = wx;
    this.cam.gy = wy;
  }

  goHome() {
    const h = this.world.homes[PLAYER];
    this.centerOn(tileX(h.col, h.row) + CX, tileY(h.row) + CY);
  }

  focusTile(col: number, row: number) {
    this.centerOn(tileX(col, row) + CX, tileY(row) + CY);
    this.select([col, row]);
  }

  setZoom(z: number) {
    this.cam.tz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  }

  demolishSelected() {
    if (!this.selected) return;
    const r = this.world.demolish(...this.selected);
    if (!r.ok) toast(r.reason!, 'bad');
    this.select(this.selected);
  }

  getView() {
    const w = this.host.clientWidth / this.cam.zoom, h = this.host.clientHeight / this.cam.zoom;
    return { x: this.cam.x - w / 2, y: this.cam.y - h / 2, w, h };
  }

  /** Low-res overview for the minimap; rebuilt only when territory changes. */
  minimap() {
    const { world } = this;
    if (this.mini && this.mini.v === world.version) return this.mini.cv;
    const cv = this.mini?.cv ?? document.createElement('canvas');
    cv.width = world.cols * 4 + 2;
    cv.height = world.rows * 3 + 1;
    const g = cv.getContext('2d')!;
    g.clearRect(0, 0, cv.width, cv.height);
    for (const t of world.tiles) {
      if (t.kind === 'void') continue;
      const x = t.col * 4 + (t.row & 1) * 2, y = t.row * 3;
      let border = false;
      if (t.owner >= 0) for (let d = 0; d < 6; d++) if (world.tile(...neighbor(t.col, t.row, d))?.owner !== t.owner) border = true;
      g.fillStyle = MINI_COLORS[t.kind];
      g.fillRect(x, y, 4, 3);
      if (t.owner >= 0) {
        g.globalAlpha = border ? 0.95 : 0.32;
        g.fillStyle = FACTIONS[t.owner].color;
        g.fillRect(x, y, 4, 3);
        g.globalAlpha = 1;
      }
      if (t.structure) {
        g.fillStyle = t.structure.kind === 'nexus' ? '#ffffff' : FACTIONS[t.structure.owner].color;
        g.fillRect(x + 1, y, 2, 2);
      }
    }
    this.mini = { cv, v: world.version };
    return cv;
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
      } else if (k === 'h') this.goHome();
      else if (k === '=' || k === '+') this.setZoom(this.cam.tz + 1);
      else if (k === '-') this.setZoom(this.cam.tz - 1);
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

  private click() {
    const h = this.hover;
    if (this.buildMode) {
      if (!h) return;
      const kind = this.buildMode;
      const r = this.world.build(kind, h[0], h[1]);
      if (!r.ok) return toast(r.reason!, 'bad');
      toast(`${STRUCT[kind].name} — construction started`, 'good');
      this.select(h);
      if (!this.mouse.shift) this.setBuildMode(null);
      return;
    }
    const t = h && this.world.tile(...h);
    this.select(t && t.kind !== 'void' ? h : null);
  }

  private select(t: [number, number] | null) {
    this.selected = t;
    this.hud.set({ selected: t ? this.snap(t[0], t[1], false) : null });
  }

  private snap(col: number, row: number, withBuild: boolean): TileSnap {
    const t = this.world.tile(col, row)!;
    const s = t.structure;
    const snap: TileSnap = {
      col, row, kind: t.kind, variant: t.variant, owner: t.owner,
      structure: s ? { kind: s.kind, progress: s.progress, level: s.level, owner: s.owner } : null,
    };
    if (withBuild && this.buildMode) Object.assign(snap, this.world.canBuild(this.buildMode, col, row));
    return snap;
  }

  // ---------------------------------------------------------------- loop
  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, (now - (this.last || now)) / 1000);
    this.last = now;
    const t = now / 1000;
    this.world.update(dt);
    this.updateCamera(dt);
    this.updateHover();
    this.updateShips(dt);
    this.render(t, dt);
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
    c.zoom += (c.tz - c.zoom) * (1 - Math.exp(-dt * 14));
    if (Math.abs(c.tz - c.zoom) < 0.002) c.zoom = c.tz;
    if (c.zoom !== prev && this.mouse.inside) {
      // Keep the world point under the cursor fixed while zooming.
      const mx = this.mouse.x - this.host.clientWidth / 2, my = this.mouse.y - this.host.clientHeight / 2;
      c.x += mx / prev - mx / c.zoom;
      c.y += my / prev - my / c.zoom;
    }
    c.x = Math.max(0, Math.min(this.world.pxW, c.x));
    c.y = Math.max(0, Math.min(this.world.pxH, c.y));
  }

  private updateHover() {
    const { cam, mouse } = this;
    const wx = cam.x + (mouse.x - this.host.clientWidth / 2) / cam.zoom;
    const wy = cam.y + (mouse.y - this.host.clientHeight / 2) / cam.zoom;
    const p = mouse.inside && !this.drag?.moved ? pick(wx, wy) : null;
    const t = p && this.world.tile(...p);
    this.hover = t && t.kind !== 'void' ? p : null;
    const key = this.hover ? `${this.hover}|${this.buildMode}|${this.world.version}` : '';
    if (key !== this.hoverKey) {
      this.hoverKey = key;
      this.hud.set({ hover: this.hover ? this.snap(this.hover[0], this.hover[1], true) : null });
    }
  }

  private syncHud(dt: number) {
    this.syncAcc += dt;
    if (this.syncAcc < 0.2) return;
    this.syncAcc = 0;
    const w = this.world;
    this.hud.set({
      res: { ...w.res },
      rates: w.rates(PLAYER),
      cycle: w.cycle,
      sectors: w.ownedTiles(PLAYER).length,
      zoom: this.cam.tz,
      selected: this.selected ? this.snap(this.selected[0], this.selected[1], false) : null,
      hover: this.hover ? this.snap(this.hover[0], this.hover[1], true) : null,
    });
  }

  // ---------------------------------------------------------------- ships & particles
  private updateShips(dt: number) {
    const online = this.world.structures.filter((s) => s.progress >= 1);
    for (const f of FACTIONS) {
      const mine = online.filter((s) => s.owner === f.id);
      const bays = mine.filter((s) => s.kind === 'dronebay' || s.kind === 'nexus');
      const cap = Math.min(14, 1 + mine.filter((s) => s.kind === 'dronebay').length * 3);
      if (mine.length < 2 || this.ships.filter((s) => s.f === f.id).length >= cap || Math.random() > dt * 1.5) continue;
      const a = bays[Math.floor(Math.random() * bays.length)];
      let b: Structure = a;
      while (b === a) b = mine[Math.floor(Math.random() * mine.length)];
      const [x0, y0] = this.structTop(a), [x1, y1] = this.structTop(b);
      const dist = Math.hypot(x1 - x0, y1 - y0);
      this.ships.push({ f: f.id, x0, y0, x1, y1, t: 0, dur: 0.8 + dist / 55, arc: Math.min(40, dist * 0.22), trail: [] });
    }
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
    const scale = this.cam.zoom * dpr;
    const vw = pw / scale, vh = ph / scale;
    const ox0 = this.cam.x - vw / 2, oy0 = this.cam.y - vh / 2;
    const ox = Math.floor(ox0), oy = Math.floor(oy0);
    const lw = Math.ceil(vw) + 2, lh = Math.ceil(vh) + 2;
    for (const L of [this.bg, this.col, this.emit, this.light]) {
      if (L.cv.width !== lw || L.cv.height !== lh) {
        L.cv.width = lw;
        L.cv.height = lh;
      }
      L.ctx.imageSmoothingEnabled = false;
      L.ctx.globalAlpha = 1;
      L.ctx.globalCompositeOperation = 'source-over';
      L.ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    this.drawBackground(ox, oy, lw, lh, t);
    this.drawWorld(ox, oy, lw, lh, t, dt);
    this.post.render({ bg: this.bg.cv, col: this.col.cv, emit: this.emit.cv, light: this.light.cv, pw, ph, scale, fx: ox0 - ox, fy: oy0 - oy, time: t });
  }

  private drawBackground(ox: number, oy: number, lw: number, lh: number, t: number) {
    const g = this.bg.ctx;
    g.fillStyle = '#03040a';
    g.fillRect(0, 0, lw, lh);
    const neb = assets.nebula, P = 0.18;
    const nx = Math.round(lw / 2 - (this.cam.x - this.world.pxW / 2) * P - neb.width);
    const ny = Math.round(lh / 2 - (this.cam.y - this.world.pxH / 2) * P - neb.height);
    g.drawImage(neb, nx, ny, neb.width * 2, neb.height * 2);

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

  private drawWorld(ox: number, oy: number, lw: number, lh: number, t: number, dt: number) {
    const { world } = this;
    const c = this.col.ctx, e = this.emit.ctx, l = this.light.ctx;
    c.clearRect(0, 0, lw, lh);
    e.clearRect(0, 0, lw, lh);
    l.fillStyle = '#000';
    l.fillRect(0, 0, lw, lh);
    for (const g of [c, e, l]) g.setTransform(1, 0, 0, 1, -ox, -oy);
    e.globalCompositeOperation = 'lighter';
    l.globalCompositeOperation = 'lighter';

    const r0 = Math.max(0, Math.floor((oy - 24) / RH)), r1 = Math.min(world.rows - 1, Math.floor((oy + lh + 48) / RH));
    const c0 = Math.max(0, Math.floor((ox - 48) / TW)), c1 = Math.min(world.cols - 1, Math.floor((ox + lw + 16) / TW));
    const pulse = 0.78 + 0.22 * Math.sin(t * 2.2);
    const build = this.buildMode;

    for (let r = r0; r <= r1; r++) {
      for (let col = c0; col <= c1; col++) {
        const tile = world.tile(col, r)!;
        if (tile.kind === 'void') continue;
        const x = tileX(col, r), y = tileY(r);
        const spr = assets.tile(tile.kind, tile.variant);
        c.drawImage(spr.color, x, y - TILE_PAD);
        if (spr.emit) {
          e.globalAlpha = tile.kind === 'crystal' || tile.kind === 'gas' ? 0.6 + 0.4 * Math.sin(t * 1.6 + tile.seed * 40) : 1;
          e.drawImage(spr.emit, x, y - TILE_PAD);
          e.globalAlpha = 1;
        }
        if (tile.kind === 'crystal' || tile.kind === 'gas') {
          const lc = tile.kind === 'crystal' ? '#4fe6ff' : '#b65cff';
          l.globalAlpha = 0.32;
          l.drawImage(assets.light(lc), x + CX - 22, y + CY - 22, 44, 44);
          if (Math.random() < dt * (tile.kind === 'gas' ? 1.2 : 0.8)) this.spawnTileParticle(tile.kind, x, y);
        }
        if (tile.owner >= 0) {
          const f = FACTIONS[tile.owner];
          l.globalAlpha = 0.09;
          l.drawImage(assets.fill(f.color), x, y);
          e.globalAlpha = 0.7 * pulse;
          for (let d = 0; d < 6; d++) if (world.tile(...neighbor(col, r, d))?.owner !== tile.owner) e.drawImage(assets.edges[tile.owner][d], x, y);
        }
        if (build && world.canBuild(build, col, r).ok) {
          l.globalAlpha = 0.28 + 0.1 * Math.sin(t * 4);
          l.drawImage(assets.fill('#5cff9d'), x, y);
        }
        l.globalAlpha = 1;
        e.globalAlpha = 1;
      }
      for (let col = c0; col <= c1; col++) {
        const s = world.tile(col, r)!.structure;
        if (s) this.drawStructure(s, tileX(col, r), tileY(r), t);
      }
    }

    this.drawShips(c, e, l);
    for (const p of this.parts) {
      e.globalAlpha = Math.min(1, p.life / p.max * 1.6);
      e.fillStyle = p.col;
      e.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
    }
    e.globalAlpha = 1;
    this.drawOverlays(c, e, l, t);
  }

  private spawnTileParticle(kind: TileKind, x: number, y: number) {
    if (this.parts.length > 400) return;
    const px = x + 8 + Math.random() * 16, py = y + 8 + Math.random() * 12;
    if (kind === 'gas') this.parts.push({ x: px, y: py, vx: (Math.random() - 0.5) * 4, vy: -6 - Math.random() * 6, life: 2.4, max: 2.4, col: '#c57bff' });
    else this.parts.push({ x: px, y: py - 6, vx: 0, vy: -2, life: 0.6, max: 0.6, col: '#d6fffd' });
  }

  private drawStructure(s: Structure, x: number, y: number, t: number) {
    const c = this.col.ctx, e = this.emit.ctx, l = this.light.ctx;
    const spr = assets.structure(s.kind, s.owner);
    const f = FACTIONS[s.owner];
    const sx = x + SOX, sy = y + SOY;
    const def = STRUCT[s.kind];
    const seed = this.world.tile(s.col, s.row)!.seed;

    if (s.progress < 1) {
      // Hologram fabrication: solid from the ground up, scanning beam at the build line.
      const cut = Math.round(60 * (1 - s.progress));
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
      const on = Math.sin(t * 3 + seed * 20) > 0.55;
      if (!on) continue;
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

    const R = def.light;
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

  private drawOverlays(c: CanvasRenderingContext2D, e: CanvasRenderingContext2D, l: CanvasRenderingContext2D, t: number) {
    const me = FACTIONS[PLAYER];
    if (this.selected) {
      const [col, row] = this.selected;
      const x = tileX(col, row), y = tileY(row);
      e.globalAlpha = 0.75 + 0.25 * Math.sin(t * 5);
      e.drawImage(assets.outline(me.color), x, y);
      const tall = this.world.tile(col, row)?.structure ? 40 : 6;
      e.globalAlpha = 1;
      e.drawImage(assets.chevrons[PLAYER], x + CX - 3, y + CY - tall - 8 + Math.round(Math.sin(t * 4) * 2));
    }
    if (this.hover) {
      const [col, row] = this.hover;
      const x = tileX(col, row), y = tileY(row);
      l.globalAlpha = 0.22;
      l.drawImage(assets.fill('#ffffff'), x, y);
      l.globalAlpha = 1;
      if (this.buildMode) {
        const ok = this.world.canBuild(this.buildMode, col, row).ok;
        e.globalAlpha = 0.95;
        e.drawImage(assets.outline(ok ? '#5cff9d' : '#ff4f6a'), x, y);
        if (!this.world.tile(col, row)?.structure) {
          e.globalAlpha = ok ? 0.75 : 0.35;
          e.drawImage(assets.structure(this.buildMode, PLAYER).holo, x + SOX, y + SOY);
        }
        e.globalAlpha = 1;
      } else {
        e.globalAlpha = 0.55;
        e.drawImage(assets.outline('#dff6ff'), x, y);
        e.globalAlpha = 1;
      }
    }
  }
}
