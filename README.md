# Eden

A persistent sci-fi territory builder: every player builds on the same hex cluster.

## Layout

An npm-workspaces monorepo. Architecture and the reasoning behind it: [docs/design/backend.md](docs/design/backend.md).

```
shared/             game rules, the simulation (Sector) and the wire protocol, used by browser and servers
client/             React + Vite + TypeScript front end (WebGL2 renderer)
services/accounts   sign-in (guest, Discord, Google), sessions, access tokens
services/gateway    WebSocket edge: verifies tokens, bridges sockets to NATS
services/shard      the authoritative sector: simulation + Postgres persistence
services/kit        shared server plumbing (logs, config, migrations, probes, NATS subjects)
scripts/smoke.ts    end-to-end test against a running stack
```

## Run it

```
npm install
docker compose up --build      # the whole stack on http://localhost:8080
npm run dev -w @eden/client    # optional: hot-reloading client on :5173, talking to the stack above
```

`?offline` runs a whole sector inside the page instead (no backend; rival empires sit idle).
Deep links: `?at=col,row&zoom=4`. Copy `.env.example` to `.env` for real passwords and OAuth keys.

Checks:

```
npm run typecheck && npm test        # every workspace
npx tsx scripts/smoke.ts play        # against the running stack (also: restart, erase)
```

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

- `shared/src/protocol.ts` is the client ↔ shard contract (`WorldSource`): subscribe to chunk keys, receive a
  snapshot then revisioned, idempotent deltas. The client resyncs a chunk if a revision is skipped.
- `shared/src/terrain.ts` is deterministic terrain shared by both sides, so the shard only sends what players
  changed (ownership, structures, terrain overrides), never terrain itself.
- `shared/src/rules.ts` holds build validation shared by client (instant feedback) and shard (authoritative).
- `shared/src/sim/Sector.ts` is the authoritative simulation for any number of empires: sparse state,
  timestamp-based construction and health, per-chunk delta batching, dirty tracking for persistence. No I/O.
  The shard service runs it behind NATS and Postgres; `LocalShard` runs it in-process for tests and `?offline`.
- `game/WorldView.ts` is the client chunk cache: viewport subscriptions with hysteresis, nearest-first
  terrain generation under a frame budget, LRU eviction, revision checks. No DOM, so it's unit tested.
- `game/render/maps.ts` covers the zoomed-out levels of detail: baked per-chunk map images, and a whole-world
  map (procedural terrain plus the shard's ownership overview) that also feeds the minimap.

Levels of detail: crisp pixel-art tiles (zoom ≥ 2) → scaled tiles → chunk maps (crossfade 0.95–0.75)
→ world map once more than 300 chunks would be in view (streaming stops).

Press **F3** (or add `?debug`) for the chunk overlay: chunk grid by stream state, cache/subscription counts,
snapshots, deltas and resyncs.

```
npm test   # chunk maths, terrain determinism, client/shard convergence, packet-loss resync, flight model
```

## Flagship (prototype)

The player is a ship. **Space** toggles pilot mode (camera locks on; W/S thrust, A/D steer, Shift boost);
**right-click** anywhere flies there on autopilot; **F** finds your ship.

- `game/ships/voxel.ts` ray-casts a small voxel model into pixel-art sprites (64 headings × 5 bank angles,
  rendered lazily) using the world's camera pitch, light and palettes.
- `game/ships/flagship.ts` is the ship's shape as a function over model space.
- `game/ships/flight.ts` is a pure, deterministic flight step, so the server can run the same code later.
  Simulated client-side for now.

### Hulls & fitting

Press **G** (or the Hangar button) to open the hangar. Four hulls (`game/ships/hulls.ts`): Wisp
(interceptor), Lancer (strike cruiser), Bastion (heavy gunship), Mule (hauler). Each has high (weapons,
mining/salvage beams), mid (tools/utility) and low (passive upgrades) slots plus **CPU** and **power**
budgets. Modules live in `game/ships/modules.ts`; the rules and final stats are pure functions in
`game/ships/fitting.ts` (shared with the server later). Repeated multipliers get diminishing returns.
Fitted stats drive the flight model, so an armour-plated Bastion really does handle like a brick.
The hangar saves to localStorage for now.

Dev tools: `/ships.html` renders every hull's sprite sheet; `?shipdemo` flies a loop; `?hangar` opens
the hangar on load.
