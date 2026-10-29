import { ResKey } from '../game/defs';

// Pixel glyphs: each char indexes the palette ('.' = empty). Rendered as SVG rects
// so they stay crisp at any integer scale.
function Glyph({ rows, pal, size }: { rows: string[]; pal: Record<string, string>; size: number }) {
  const w = rows[0].length, h = rows.length;
  return (
    <svg width={size * (w / h)} height={size} viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges" className="glyph">
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

export function ResIcon({ k, size = 14 }: { k: ResKey; size?: number }) {
  return <Glyph rows={RES[k].rows} pal={RES[k].pal} size={size} />;
}

const UI_GLYPHS = {
  home: ['...1...', '..111..', '.11111.', '1111111', '.1.1.1.', '.1...1.', '.11111.'],
  plus: ['.......', '...1...', '...1...', '.11111.', '...1...', '...1...', '.......'],
  minus: ['.......', '.......', '.......', '.11111.', '.......', '.......', '.......'],
};

export function UiIcon({ name, size = 14, color = '#c9d6e6' }: { name: keyof typeof UI_GLYPHS; size?: number; color?: string }) {
  return <Glyph rows={UI_GLYPHS[name]} pal={{ '1': color }} size={size} />;
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
