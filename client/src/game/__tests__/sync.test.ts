// End-to-end streaming test: a shard runs its AI for a while, and every chunk
// the client is subscribed to must match the shard exactly.
import { describe, expect, it } from 'vitest';
import { CS, localIndex } from '../chunks';
import { PLAYER } from '../defs';
import { tileX, tileY } from '../hex';
import type { ChunkDelta, SourceHandlers, WorldSource } from '../protocol';
import { LocalShard } from '../sim/LocalShard';
import { WorldView } from '../WorldView';

function setup(wrap?: (s: LocalShard) => WorldSource) {
  let t = 0;
  const shard = new LocalShard({ seed: 7, radiusPx: 6000, latencyMs: 0, manual: true, clock: () => t });
  const view = new WorldView(wrap ? wrap(shard) : shard);
  const advance = (seconds: number) => {
    for (let i = 0; i < seconds * 10; i++) {
      t += 0.1;
      shard.step(0.1);
    }
  };
  return { shard, view, advance };
}

/** Look at a faction's home, zoomed out enough to cover a few chunks. */
function lookAt(view: WorldView, f: number) {
  const h = view.meta!.homes[f];
  const x = tileX(h.col, h.row), y = tileY(h.row);
  view.update({ x: x - 1500, y: y - 900, w: 3000, h: 1800 }, 1000);
}

function expectInSync(view: WorldView, shard: LocalShard) {
  let checked = 0;
  for (const c of view.chunks.values()) {
    if (!view.isSubscribed(c.key) || !c.stateReady) continue;
    for (let lr = 0; lr < CS; lr++)
      for (let lc = 0; lc < CS; lc++) {
        const col = c.cx * CS + lc, row = c.cy * CS + lr, i = localIndex(col, row);
        expect(c.kind[i]).toBe(shard.kindId(col, row));
        expect(c.owner[i]).toBe(shard.owner(col, row));
        expect(c.structures.get(i)?.id).toBe(shard.structure(col, row)?.id);
        expect(c.structures.get(i)?.finishAt).toBe(shard.structure(col, row)?.finishAt);
      }
    checked++;
  }
  expect(checked).toBeGreaterThan(4);
}

describe('chunk streaming', () => {
  it('client chunks converge to shard state while the world changes', async () => {
    const { shard, view, advance } = setup();
    await view.connect();
    for (let f = 1; f < 4; f++) {
      lookAt(view, f);
      advance(60);
      expectInSync(view, shard);
    }
    expect(view.stats.deltas).toBeGreaterThan(0);
    expect(view.stats.resyncs).toBe(0);
  });

  it('player builds round-trip through the shard', async () => {
    const { shard, view, advance } = setup();
    await view.connect();
    lookAt(view, PLAYER);
    const home = view.meta!.homes[PLAYER];
    // Find an empty owned tile next to the Nexus.
    let spot: [number, number] | null = null;
    for (let dr = -2; dr <= 2 && !spot; dr++)
      for (let dc = -2; dc <= 2 && !spot; dc++) {
        const c = home.col + dc, r = home.row + dr;
        if (view.canBuild('solar', c, r).ok) spot = [c, r];
      }
    expect(spot).not.toBeNull();
    const res = await view.build('solar', ...spot!);
    expect(res.ok).toBe(true);
    advance(0.2);
    expect(view.structure(...spot!)?.kind).toBe('solar');
    expect(view.structure(...spot!)?.owner).toBe(PLAYER);
    expectInSync(view, shard);
  });

  it('detects a dropped delta and resyncs the chunk', async () => {
    let dropNext = false;
    const { shard, view, advance } = setup((s) => ({
      connect: (h: SourceHandlers) =>
        s.connect({
          ...h,
          delta: (d: ChunkDelta) => {
            if (dropNext) { dropNext = false; return; } // simulate packet loss
            h.delta(d);
          },
        }),
      subscribe: (k) => s.subscribe(k),
      unsubscribe: (k) => s.unsubscribe(k),
      build: (...a) => s.build(...a),
      demolish: (...a) => s.demolish(...a),
      fire: (o) => s.fire(o),
      now: () => s.now(),
    }));
    await view.connect();
    lookAt(view, 1);
    advance(5);
    dropNext = true;
    advance(90);
    expect(view.stats.resyncs).toBeGreaterThan(0);
    expectInSync(view, shard);
  });

  it('stops detailed streaming when zoomed far out', async () => {
    const { view } = setup();
    await view.connect();
    view.update({ x: -6000, y: -6000, w: 12000, h: 12000 }, 50);
    expect(view.detail).toBe(true);
    view.update({ x: -60000, y: -60000, w: 120000, h: 120000 }, 50);
    expect(view.detail).toBe(false);
    expect(view.stats.subscribed).toBe(0);
  });
});
