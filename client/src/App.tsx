import { useEffect, useRef, useState } from 'react';
import { Engine } from './game/engine';
import { hud, setEngine, world } from './game/game';
import { BuildDock } from './ui/BuildDock';
import { DebugPanel } from './ui/DebugPanel';
import { HangarWindow } from './ui/HangarWindow';
import { Feed } from './ui/Feed';
import { Minimap } from './ui/Minimap';
import { AimBanner, BuildBanner, DeployBanner, PilotBanner, Toasts, Tooltip } from './ui/Overlays';
import { SelectionPanel } from './ui/SelectionPanel';
import { ShipPanel } from './ui/ShipPanel';
import { ShipStatus } from './ui/ShipStatus';
import { StorageWindow } from './ui/StorageWindow';
import { installSkin } from './ui/skin';
import { TopBar } from './ui/TopBar';

installSkin();

export function App() {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let engine: Engine | null = null;
    let cancelled = false;
    (async () => {
      try {
        if (!world.meta) await world.connect();
        if (cancelled) return;
        engine = new Engine(host.current!, world, hud);
        setEngine(engine);
        setReady(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      engine?.dispose();
      setEngine(null);
    };
  }, []);

  return (
    <div className="app">
      <div ref={host} className="game-host" />
      {error && <div className="fatal f-panel">{error}</div>}
      {!ready && !error && <div className="connecting">Connecting to Kestrel Cluster…</div>}
      {ready && (
        <div className="hud">
          <TopBar />
          <ShipStatus />
          <Feed />
          <BuildBanner />
          <PilotBanner />
          <AimBanner />
          <DeployBanner />
          <Toasts />
          <Minimap />
          <SelectionPanel />
          <BuildDock />
          <DebugPanel />
          <Tooltip />
          <StorageWindow />
          <ShipPanel />
          <HangarWindow />
        </div>
      )}
    </div>
  );
}
