import { ResKey } from '../game/defs';

// 9x9 pixel glyphs: '1' = base colour, '2' = highlight.
const GLYPHS: Record<ResKey, string[]> = {
  credits: ['...111...', '.1122211.', '.12...21.', '12.111.21', '12.1...21', '12.111.21', '.12...21.', '.1122211.', '...111...'],
  alloy: ['.........', '...22222.', '..222221.', '.2222211.', '21111111.', '11111111.', '1111111..', '.........', '.........'],
  energy: ['....221..', '...221...', '..221....', '.2222221.', '....221..', '...221...', '..221....', '.21......', '.........'],
  crystal: ['....2....', '...221...', '..22211..', '.2221111.', '222211111', '.2221111.', '..22211..', '...221...', '....1....'],
};
const COLORS: Record<ResKey, [string, string]> = {
  credits: ['#e0a93a', '#fff0b8'],
  alloy: ['#7f93ad', '#e3edf7'],
  energy: ['#2fc6e0', '#d6fdff'],
  crystal: ['#9b6cf0', '#efe2ff'],
};

export function ResIcon({ k, size = 18 }: { k: ResKey; size?: number }) {
  const [a, b] = COLORS[k];
  return (
    <svg width={size} height={size} viewBox="0 0 9 9" shapeRendering="crispEdges" className="px-icon">
      {GLYPHS[k].flatMap((row, y) =>
        [...row].map((ch, x) => (ch === '.' ? null : <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={ch === '1' ? a : b} />)),
      )}
    </svg>
  );
}
