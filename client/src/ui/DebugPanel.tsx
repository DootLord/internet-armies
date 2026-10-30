import { useEffect, useState } from 'react';
import { CS } from '../game/chunks';
import { getEngine, world } from '../game/game';
import { MAX_CACHED_CHUNKS, MAX_DETAIL_CHUNKS } from '../game/WorldView';

/** F3 overlay: what the chunk streamer is doing right now. */
export function DebugPanel() {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);
  const eng = getEngine();
  if (!eng?.debug) return null;
  const s = world.stats, e = eng.stats;
  const rows: [string, string | number][] = [
    ['FPS', e.fps],
    ['Zoom', `${e.zoom.toFixed(2)}× · ${e.lod}`],
    ['Tiles drawn', e.tiles],
    ['Chunks cached', `${s.cached} / ${MAX_CACHED_CHUNKS}`],
    ['Subscribed', `${s.subscribed}${s.detail ? '' : ` (detail off > ${MAX_DETAIL_CHUNKS})`}`],
    ['Awaiting snapshot', s.awaiting],
    ['Terrain queue', s.genQueue],
    ['Snapshots / deltas', `${s.snapshots} / ${s.deltas}`],
    ['Resyncs', s.resyncs],
    ['Structures known', world.structures.size],
    ['Chunk size', `${CS}×${CS}`],
  ];
  return (
    <div className="debug f-tip">
      <b>Debug · F3</b>
      {rows.map(([k, v]) => (
        <div key={k} className="debug-row">
          <span className="muted">{k}</span>
          <span className="num">{v}</span>
        </div>
      ))}
      <div className="debug-legend">
        <i style={{ background: '#5cff9d' }} /> live <i style={{ background: '#ffc35c' }} /> awaiting <i style={{ background: '#4b5b78' }} /> cached{' '}
        <i style={{ background: '#ff4f6a' }} /> no terrain
      </div>
    </div>
  );
}
