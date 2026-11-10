# Eden

A sci-fi territory-builder prototype: command a fleet and build territory across a shared hex cluster,
currently simulated locally against AI factions.

## Layout

```
client/   React + Vite + TypeScript front end (WebGL2 renderer)
docs/     Design notes
```

The world currently runs in-process in `client/src/game/sim/LocalShard.ts`; there is no separate
server yet.

## Run the client

```
cd client
npm install
npm run dev          # http://localhost:5173
npm test             # Vitest unit tests
npm run build        # Type-check and production build
```

Deep links: `?at=col,row&zoom=4`, or `?at=f2` to jump to a faction's home.

## How rendering works

- `game/sprites.ts` paints all pixel art procedurally into a **colour** layer and an **emissive** layer.
- `game/engine.ts` draws the visible world each frame into four small "art-resolution" canvases:
  background (nebula + parallax stars), colour, emissive, and a light map.
- `game/post.ts` (WebGL2) lights the colour layer with the light map, blooms everything bright,
  upscales with sharp-bilinear filtering (crisp pixels, smooth sub-pixel camera), then tone-maps,
  grades, adds vignette, chromatic fringe and grain.

## World streaming (chunks)

One persistent map, streamed like Minecraft. Defaults: a disc of ~0.9M hex slots (`?radius=` in world px to
stress-test), 32×32-hex chunks.

- `game/protocol.ts` is the client ↔ shard contract (`WorldSource`): subscribe to chunk keys, receive a
  snapshot then revisioned, idempotent deltas. The client resyncs a chunk if a revision is skipped.
- `game/terrain.ts` is deterministic terrain shared by both sides, so the shard only sends what players
  changed (ownership, structures, terrain overrides), never terrain itself.
- `game/rules.ts` holds build validation shared by client (instant feedback) and shard (authoritative).
- `game/sim/LocalShard.ts` is the in-process stand-in for the Node shard: sparse state, AI factions,
  timestamp-based construction, per-chunk delta batching, simulated latency. No DOM.
- `game/WorldView.ts` is the client chunk cache: viewport subscriptions with hysteresis, nearest-first
  terrain generation under a frame budget, LRU eviction, revision checks. No DOM, so it's unit tested.
- `game/render/maps.ts` covers the zoomed-out levels of detail: baked per-chunk map images, and a whole-world
  map (procedural terrain plus the shard's ownership overview) that also feeds the minimap.

Levels of detail: crisp pixel-art tiles (zoom ≥ 2) → scaled tiles → chunk maps (crossfade 0.95–0.75)
→ world map once more than 300 chunks would be in view (streaming stops).

Press **F3** (or add `?debug`) for the chunk overlay: chunk grid by stream state, cache/subscription counts,
snapshots, deltas and resyncs.

The tests cover chunk maths, terrain determinism, client/shard convergence, packet-loss resync, flight,
combat, fleets, cargo and other game systems.

## Gameplay

Build and expand a territory across a streamed hex world. Extractors harvest tile deposits; solar arrays
and habitats support your economy, while relays extend your territory. Defend it with turrets and shield
pylons, and deploy mech squads from Mech Bays to attack enemy structures. Fly to caches and salvage
their cargo, or mine deposits directly with a fitted Mining Beam.

The player commands a fleet of six hulls: Wisp (interceptor), Lancer (strike cruiser), Regent (command
cruiser), Bastion (heavy gunship), Halberd (destroyer) and Mule (hauler). **Space** toggles pilot mode
(camera locks on; W/S thrust, A/D steer, Shift boost); **right-click** flies there on autopilot; **F**
finds your ship. Use **E** to aim weapons, **T** to deploy a mech at a selected enemy structure, and **G**
to open the ship panel.

### Hulls & fitting

Press **G** (or the Ship button) to open your ship and cargo. At a Hangar, dock to station, board, refit,
and transfer cargo between ships. Each hull has high (weapons and beams), mid (tools and utility) and
low (passive upgrades) slots plus **CPU** and **power** budgets. Modules live in
`client/src/game/ships/modules.ts`; fitting rules and final stats are pure functions in
`client/src/game/ships/fitting.ts`. Repeated multipliers get diminishing returns, and fitted stats drive
the flight model. Fleet, cargo, combat, construction and world simulation currently run in the
in-process shard.

Dev tools: `/ships.html` renders every hull's sprite sheet; `?shipdemo` flies a loop; `?hangar` opens
the hangar on load.
