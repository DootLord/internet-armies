import { useEffect, useRef, useState } from 'react';
import { Engine } from './game/engine';
import { hud, setEngine, world } from './game/game';
import { BuildDock } from './ui/BuildDock';
import { Feed } from './ui/Feed';
import { Minimap } from './ui/Minimap';
import { BuildBanner, KeyHints, Toasts, Tooltip } from './ui/Overlays';
import { SelectionPanel } from './ui/SelectionPanel';
import { TopBar } from './ui/TopBar';

export function App() {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let engine: Engine | null = null;
    try {
      engine = new Engine(host.current!, world, hud);
      setEngine(engine);
      setReady(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    return () => {
      engine?.dispose();
      setEngine(null);
    };
  }, []);

  return (
    <div className="app">
      <div ref={host} className="game-host" />
      {error && <div className="fatal panel">{error}</div>}
      {ready && (
        <div className="hud">
          <TopBar />
          <Feed />
          <BuildBanner />
          <Toasts />
          <Minimap />
          <SelectionPanel />
          <BuildDock />
          <KeyHints />
          <Tooltip />
        </div>
      )}
    </div>
  );
}
