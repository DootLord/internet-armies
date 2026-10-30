import { CSSProperties, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cargo, fleet, getEngine, toast, world } from '../game/game';
import type { CargoOp, CargoState, Container } from '../game/protocol';
import { canPlace, CARGO_COLS, cargoGrid, CargoItem, footprint, Grid, inGrid, insertItem, ItemKind, ITEMS, moveItem, removeItem, STORAGE_GRID, usedCells } from '../game/ships/cargo';
import { computeStats } from '../game/ships/fitting';
import { HANGAR_GRID } from '../game/ships/fleet';
import { itemPose, itemSpan } from '../game/itemArt';

/** One grid on screen: a ship hold or a Storage. `locked` explains why it can't be touched right now. */
export interface Bay {
  key: string;
  label: string;
  container: Container;
  items: CargoItem[];
  grid: Grid;
  locked?: string;
}

/** An item being carried: where from, its orientation, the grabbed cell within it, and the pointer. */
interface Drag { bay: string; uid: number; rot: boolean; gx: number; gy: number; px: number; py: number }

const cells = (n: number) => `calc(var(--cell) * ${n})`;

/** A container's grid: a ship's comes from its fitted cargo stat, a building's is fixed by its kind. */
export function gridOf(c: Container): Grid {
  if ('ship' in c) {
    const sh = fleet.get().ships.find((s) => s.id === c.ship);
    return sh ? cargoGrid(computeStats(sh.hull, sh.fit).cargo) : { w: CARGO_COLS, h: 2 };
  }
  return world.structures.get(c.store)?.kind === 'hangar' ? HANGAR_GRID : STORAGE_GRID;
}
export const itemsOf = (s: CargoState, c: Container) => ('ship' in c ? s.holds[c.ship] : s.stores[c.store]) ?? [];
const withItems = (s: CargoState, c: Container, v: CargoItem[]): CargoState =>
  'ship' in c ? { ...s, holds: { ...s.holds, [c.ship]: v } } : { ...s, stores: { ...s.stores, [c.store]: v } };

/** A Bay for any container, read from a cargo snapshot. */
export const bayOf = (s: CargoState, key: string, label: string, c: Container, locked?: string): Bay => ({ key, label, container: c, items: itemsOf(s, c), grid: gridOf(c), locked });

/**
 * Apply a cargo op to the local copy straight away (same rules as the shard),
 * then send it. The shard always replies with the true state, which replaces
 * ours: a refused move simply snaps back.
 */
function commit(op: CargoOp) {
  let s = cargo.get();
  const from = itemsOf(s, op.from), it = from.find((o) => o.uid === op.uid);
  if (!it) return;
  if (op.op === 'jettison') s = withItems(s, op.from, removeItem(from, op.uid));
  else if (JSON.stringify(op.from) === JSON.stringify(op.to)) {
    const next = moveItem(from, gridOf(op.from), op.uid, op.x, op.y, op.rot);
    if (!next) return toast("Doesn't fit there", 'bad');
    s = withItems(s, op.from, next);
  } else {
    const next = insertItem(itemsOf(s, op.to), gridOf(op.to), { ...it, x: op.x, y: op.y, rot: op.rot });
    if (!next) return toast("Doesn't fit there", 'bad');
    s = withItems(withItems(s, op.from, removeItem(from, op.uid)), op.to, next);
  }
  cargo.set(s);
  const ship = getEngine()?.shipReport();
  if (ship) void world.cargoOp(op, ship).then((r) => r.ok || toast(r.reason!, 'bad'));
  if (op.op === 'jettison') toast(`Jettisoned ${ITEMS[it.kind].name}`);
}

/** A rendered voxel item, centred on its footprint. `live` sways it gently, for hover and while carried. */
function ItemArt({ it, live }: { it: Pick<CargoItem, 'kind' | 'rot'>; live?: boolean }) {
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const img = ref.current!;
    const rest = itemPose(it.kind, it.rot, 0);
    if (!live) {
      img.src = rest;
      return;
    }
    let raf = 0, last = rest;
    const t0 = performance.now();
    const tick = (now: number) => {
      // Start at rest and ease into a slow sway, swapping frames only when the pose changes.
      const ramp = Math.min(1, (now - t0) / 300);
      const src = itemPose(it.kind, it.rot, ramp * Math.sin(((now - t0) / 1000) * 2.4));
      if (src !== last) img.src = last = src;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [it.kind, it.rot, live]);
  const n = itemSpan(it.kind);
  return <img ref={ref} src={itemPose(it.kind, it.rot, 0)} alt="" draggable={false} style={{ width: cells(n), height: cells(n) }} />;
}

/** One or more cargo grids side by side: drag to pack, drag across to transfer, R rotates, drop on the bin to jettison. */
export function CargoBays({ bays, hint }: { bays: Bay[]; hint?: string }) {
  const refs = useRef(new Map<string, HTMLDivElement>());
  const binRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const baysRef = useRef(bays);
  baysRef.current = bays;
  const [drag, setDragState] = useState<Drag | null>(null);
  const [info, setInfo] = useState<ItemKind | null>(null);
  const [hot, setHot] = useState<number | null>(null);
  const setDrag = (d: Drag | null) => setDragState((dragRef.current = d));

  const cellPx = (key: string) => {
    const el = refs.current.get(key), b = baysRef.current.find((x) => x.key === key);
    return el && b ? el.getBoundingClientRect().width / b.grid.w : 30;
  };
  const over = (el: HTMLElement | null | undefined, d: Drag) => {
    const r = el?.getBoundingClientRect();
    return !!r && d.px >= r.left && d.px < r.right && d.py >= r.top && d.py < r.bottom;
  };
  /** The bay under the pointer and the cell the item's top-left would land on. */
  const landing = (d: Drag) => {
    for (const b of baysRef.current) {
      const el = refs.current.get(b.key);
      if (!el || !over(el, d)) continue;
      const r = el.getBoundingClientRect(), c = r.width / b.grid.w;
      return { bay: b, x: Math.floor((d.px - r.left) / c) - d.gx, y: Math.floor((d.py - r.top) / c) - d.gy };
    }
    return null;
  };

  const lift = (bay: Bay, it: CargoItem, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (bay.locked) return toast(bay.locked, 'bad');
    const r = e.currentTarget.getBoundingClientRect(), c = cellPx(bay.key);
    setDrag({ bay: bay.key, uid: it.uid, rot: it.rot, gx: Math.floor((e.clientX - r.left) / c), gy: Math.floor((e.clientY - r.top) / c), px: e.clientX, py: e.clientY });
  };

  const carrying = !!drag;
  useEffect(() => {
    if (!carrying) return;
    const move = (e: PointerEvent) => setDrag({ ...dragRef.current!, px: e.clientX, py: e.clientY });
    const key = (e: KeyboardEvent) => {
      const d = dragRef.current!;
      if (e.key.toLowerCase() === 'r') setDrag({ ...d, rot: !d.rot, gx: d.gy, gy: d.gx });
    };
    const up = (e: PointerEvent) => {
      const d = { ...dragRef.current!, px: e.clientX, py: e.clientY };
      setDrag(null);
      const src = baysRef.current.find((b) => b.key === d.bay);
      if (!src) return;
      if (over(binRef.current, d)) return commit({ op: 'jettison', from: src.container, uid: d.uid });
      const t = landing(d);
      if (!t) return; // dropped outside: it stays where it was
      if (t.bay.locked) return toast(t.bay.locked, 'bad');
      commit({ op: 'move', from: src.container, uid: d.uid, to: t.bay.container, x: t.x, y: t.y, rot: d.rot });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key);
    };
    // Bound once per drag; the handlers read live state through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carrying]);

  const carried = drag && bays.find((b) => b.key === drag.bay)?.items.find((o) => o.uid === drag.uid);
  const land = drag && carried ? landing(drag) : null;
  const landFoot = carried && drag ? footprint({ ...carried, rot: drag.rot }) : [0, 0];
  const landOk = !!(land && carried && !land.bay.locked && canPlace(land.bay.items.filter((o) => land.bay.key !== drag!.bay || o.uid !== drag!.uid), land.bay.grid, { ...carried, x: land.x, y: land.y, rot: drag!.rot }));
  const shown = info ?? carried?.kind ?? null;

  const itemEl = (bay: Bay, it: CargoItem, style?: CSSProperties) => {
    const [w, h] = footprint(it);
    return (
      <div
        key={it.uid}
        className={`cargo-item ${drag?.uid === it.uid ? 'lifted' : ''}`}
        style={{ width: cells(w), height: cells(h), ...style }}
        onPointerDown={(e) => lift(bay, it, e)}
        onPointerEnter={() => {
          setInfo(it.kind);
          setHot(it.uid);
        }}
        onPointerLeave={() => {
          setInfo(null);
          setHot(null);
        }}
      >
        <ItemArt it={it} live={hot === it.uid && !drag} />
      </div>
    );
  };

  return (
    <div className="cargo">
      <div className="cargo-bays">
        {bays.map((b) => {
          const overflow = b.items.filter((it) => !inGrid(it, b.grid));
          return (
            <div key={b.key} className="cargo-bay">
              <div className="cargo-head">
                <span className="muted">
                  {b.label} · {b.grid.w}×{b.grid.h}
                </span>
                <span className="num">
                  {usedCells(b.items, b.grid)} / {b.grid.w * b.grid.h}
                </span>
              </div>
              <div className="cargo-scroll">
                <div className={`cargo-grid f-inset ${b.locked ? 'locked' : ''}`}>
                  <div ref={(el) => void (el ? refs.current.set(b.key, el) : refs.current.delete(b.key))} className="cargo-cells" style={{ width: cells(b.grid.w), height: cells(b.grid.h) }}>
                    {b.items.filter((it) => inGrid(it, b.grid)).map((it) => itemEl(b, it, { left: cells(it.x), top: cells(it.y) }))}
                    {land?.bay.key === b.key && <div className={`cargo-ghost ${landOk ? '' : 'bad'}`} style={{ left: cells(land.x), top: cells(land.y), width: cells(landFoot[0]), height: cells(landFoot[1]) }} />}
                    {b.locked && <div className="cargo-lock">{b.locked}</div>}
                  </div>
                </div>
              </div>
              {overflow.length > 0 && (
                <div className="cargo-overflow f-inset">
                  <span className="bad">Overflow: no room in this hold. Drag into the grid or jettison.</span>
                  <div className="cargo-tray">{overflow.map((it) => itemEl(b, it))}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div ref={binRef} className={`cargo-bin f-inset ${drag ? 'live' : ''}`}>
        {drag ? 'Drop here to jettison' : 'Jettison'}
      </div>
      <div className="mod-info f-inset">
        {shown ? (
          <>
            <b>{ITEMS[shown].name}</b>
            <span>{ITEMS[shown].desc}</span>
            <span className="muted">
              {ITEMS[shown].w}×{ITEMS[shown].h} cells · R rotates while dragging
            </span>
          </>
        ) : (
          <span className="muted">{hint ?? 'Drag items to pack the hold.'}</span>
        )}
      </div>
      {drag &&
        carried &&
        createPortal(
          <div className="cargo-float" style={{ left: drag.px - (drag.gx + 0.5) * cellPx(drag.bay), top: drag.py - (drag.gy + 0.5) * cellPx(drag.bay), ['--cell' as string]: `${cellPx(drag.bay)}px` }}>
            <div className="cargo-item" style={{ width: cells(landFoot[0]), height: cells(landFoot[1]) }}>
              <ItemArt it={{ kind: carried.kind, rot: drag.rot }} live />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
