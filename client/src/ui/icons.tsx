import { ResKey } from '../game/defs';
import type { Slot } from '../game/ships/hulls';
import { MODULE, ModuleIconId } from '../game/ships/modules';

// Pixel glyphs: each char indexes the palette ('.' = empty). Rendered as SVG rects
// so they stay crisp at any integer scale.
export function Glyph({ rows, pal, size, glow }: { rows: string[]; pal: Record<string, string>; size: number; glow?: string }) {
  const w = rows[0].length, h = rows.length;
  return (
    <svg
      width={size * (w / h)}
      height={size}
      viewBox={`0 0 ${w} ${h}`}
      shapeRendering="crispEdges"
      className="glyph"
      style={glow ? { filter: `drop-shadow(0 0 2px ${glow}99) drop-shadow(0 0 5px ${glow}55)` } : undefined}
    >
      {rows.flatMap((row, y) => [...row].map((ch, x) => (pal[ch] ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={pal[ch]} /> : null)))}
    </svg>
  );
}

const RES: Record<ResKey, { rows: string[]; pal: Record<string, string> }> = {
  credits: {
    rows: ['..111..', '.12221.', '1221221', '1212121', '1221221', '.12221.', '..111..'],
    pal: { '1': '#a8741f', '2': '#ffd36b' },
  },
  alloy: {
    rows: ['.......', '..2222.', '.22221.', '2222111', '1111111', '1111111', '.......'],
    pal: { '1': '#5d6f8e', '2': '#c9d6e6' },
  },
  energy: {
    rows: ['...22..', '..22...', '.22....', '222222.', '...22..', '..22...', '.22....'],
    pal: { '2': '#6df2ff' },
  },
  crystal: {
    rows: ['...2...', '..221..', '.22211.', '2221111', '.22211.', '..221..', '...1...'],
    pal: { '1': '#7d4fd8', '2': '#d9c2ff' },
  },
};

export function ResIcon({ k, size = 14, glow = false }: { k: ResKey; size?: number; glow?: boolean }) {
  return <Glyph rows={RES[k].rows} pal={RES[k].pal} size={size} glow={glow ? RES[k].pal['2'] : undefined} />;
}

const UI_GLYPHS = {
  home: ['...1...', '..111..', '.11111.', '1111111', '.1.1.1.', '.1...1.', '.11111.'],
  plus: ['.......', '...1...', '...1...', '.11111.', '...1...', '...1...', '.......'],
  minus: ['.......', '.......', '.......', '.11111.', '.......', '.......', '.......'],
  close: ['1.....1', '.1...1.', '..1.1..', '...1...', '..1.1..', '.1...1.', '1.....1'],
};

export function UiIcon({ name, size = 14, color = '#c9d6e6' }: { name: keyof typeof UI_GLYPHS; size?: number; color?: string }) {
  return <Glyph rows={UI_GLYPHS[name]} pal={{ '1': color }} size={size} />;
}

/** Module glyphs; '1' takes the slot colour, '2' its highlight. */
const MODULE_GLYPHS: Record<ModuleIconId, string[]> = {
  gun: ['.......', '....222', '..1111.', '.11111.', '.11111.', '..111..', '.......'],
  missile: ['...2...', '..121..', '..111..', '..111..', '..111..', '.11.11.', '.1...1.'],
  mining: ['2......', '.2.....', '..2....', '...111.', '...1.1.', '...111.', '.......'],
  salvage: ['1.....1', '1.....1', '.1...1.', '..111..', '...1...', '...1...', '...1...'],
  shield: ['.11111.', '1222221', '1222221', '1222221', '.12221.', '..121..', '...1...'],
  thrust: ['1..1...', '.1..1..', '..1..1.', '...1..1', '..1..1.', '.1..1..', '1..1...'],
  sensor: ['...2...', '..2.2..', '.2...2.', '2..1..2', '...1...', '..111..', '.11111.'],
  tractor: ['11...11', '11...11', '11...11', '11...11', '21...12', '.11111.', '..111..'],
  plate: ['1111111', '1222221', '1211121', '1222221', '1211121', '1222221', '1111111'],
  chip: ['.1.1.1.', '1111111', '.12221.', '1122211', '.12221.', '1111111', '.1.1.1.'],
  crate: ['.11111.', '1222221', '1211121', '1222221', '1211121', '1222221', '.11111.'],
  amp: ['...1...', '..121..', '1122211', '..121..', '...1...', '..1.1..', '.1...1.'],
};

export const SLOT_COLORS: Record<Slot, [string, string]> = {
  high: ['#e8664a', '#ffc2a8'],
  mid: ['#2fb8d6', '#c8f6ff'],
  low: ['#d9a33a', '#ffeab0'],
};

export function ModuleIcon({ id, size = 21 }: { id: string; size?: number }) {
  const m = MODULE[id];
  const [a, b] = SLOT_COLORS[m.slot];
  return <Glyph rows={MODULE_GLYPHS[m.icon]} pal={{ '1': a, '2': b }} size={size} glow={b} />;
}

export function Emblem({ color, size = 22 }: { color: string; size?: number }) {
  return (
    <Glyph
      rows={['...111...', '.1122211.', '12233321.', '12333332.', '12333332.', '12333332.', '.2333322.', '.1222211.', '...111...']}
      pal={{ '1': '#04050a', '2': color, '3': '#0a0e18' }}
      size={size}
    />
  );
}
