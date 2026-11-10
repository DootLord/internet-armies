// Dev-only: the mining mini-game on its own, for tuning feel and art.
// Open http://localhost:5173/mining.html while `npm run dev` is running.
// It's the same <MiningWindow> the game will open from a deposit tile.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NODE, NodeKind } from '../game/mining/excavation';
import { ItemKind, ITEMS } from '@eden/shared/ships/cargo';
import { MiningWindow } from '../ui/MiningWindow';
import { installSkin } from '../ui/skin';
import '../styles.css';

installSkin();

function Lab() {
  const [node, setNode] = useState<NodeKind>('ore');
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9));
  const [open, setOpen] = useState(true);
  const [log, setLog] = useState<string[]>([]);
  const reroll = (n = node) => {
    setNode(n);
    setSeed(Math.floor(Math.random() * 1e9));
    setOpen(true);
  };
  const collect = (haul: ItemKind[]) => {
    setLog((l) => [`${NODE[node].name} #${seed}: ${haul.length ? haul.map((k) => ITEMS[k].name).join(', ') : 'nothing'}`, ...l].slice(0, 8));
    setOpen(false);
  };
  return (
    <div className="mining-lab">
      <div className="mining-lab-bar f-strip">
        <b>Mining lab</b>
        {(Object.keys(NODE) as NodeKind[]).map((k) => (
          <button key={k} className={`pbtn ${node === k ? 'on' : ''}`} onClick={() => reroll(k)}>
            {NODE[k].name}
          </button>
        ))}
        <button className="pbtn" onClick={() => reroll()}>
          New node
        </button>
        <span className="muted">Seed {seed}</span>
      </div>
      {open ? (
        <MiningWindow key={`${node}${seed}`} seed={seed} node={node} onClose={() => setOpen(false)} onCollect={collect} />
      ) : (
        <div className="mining-lab-log">
          {log.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
          <span className="muted">Pick a node type or "New node" to dig again.</span>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Lab />);
