# Eden

A persistent, single-shard sci-fi territory builder: every player builds on the same hex cluster.

## Layout

```
client/   React + Vite + TypeScript front end (WebGL2 renderer)
server/   PostgreSQL schema and Node account service
```

The `server/` directory currently provides PostgreSQL schema, seed data and an
email/password account service. It does **not** yet host the game world or
implement Socket.IO; gameplay remains a separate local prototype.

## Run the client

```
cd client
npm install
npm run dev        # http://localhost:5173
```

Deep links: `?at=col,row&zoom=4`, or `?at=f2` to jump to a faction's home.

## Database and accounts (early foundation)

Use PostgreSQL 17 and a dedicated database. Apply these scripts with `psql`; both
are safe to rerun without resetting existing data:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/sql/001_schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/sql/002_seed.sql
```

The seed creates the Kestrel sector (matching the local world's seed and radius)
and a default starter resource template. It does not create accounts, empires,
spawn points or world ownership. Terrain is generated from the seed; only changed
tiles are intended to be stored. The schema also reserves tables for structures,
wallets and sector stockpiles, but no gameplay API reads or writes them yet.
These scripts bootstrap a new database; `CREATE TABLE IF NOT EXISTS` does not
upgrade existing tables. Future schema changes need explicit migrations.

Install and start the account service:

```sh
cd server
npm ci
export DATABASE_URL='postgresql://USER:PASSWORD@localhost:5432/internet_armies'
export SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")"
export CLIENT_ORIGIN='http://localhost:5173'
npm start
```

Use a persistent, randomly generated `SESSION_SECRET` of at least 32 bytes across
restarts and replicas; keep it and the database URL in secret storage. For local
development, start the client with `VITE_AUTH_ENABLED=true npm run dev` in
`client/`. Vite proxies `/api` to port 3000. Without that flag the existing
local-only experience is unchanged. Register, then sign in; signing in does not
yet persist or associate the local game with the account.

For deployment, serve the client and `/api` from the same HTTPS origin with a
reverse proxy routing `/api` to the account service. Build the client with
`VITE_AUTH_ENABLED=true`, set `NODE_ENV=production` and set `CLIENT_ORIGIN` to
that exact HTTPS origin. Set `TRUST_PROXY=1` only behind one trusted reverse proxy
that overwrites forwarded headers; otherwise IP-based throttling can be bypassed.
For the client Docker image, pass `--build-arg VITE_AUTH_ENABLED=true`. Its
bundled nginx serves static files only, so the external reverse proxy must route
`/api` directly to the account service.
Configure encrypted PostgreSQL connections and certificate verification as
required by your database provider. Use a restricted database account, backups,
and monitoring. The `auth_attempts` table retains expired rate-limit buckets;
schedule periodic deletion of rows with `expires_at < now()`.

**Not production-ready yet:** there is no email verification, password reset,
account recovery, moderation, distributed abuse protection beyond IP limits, or
authoritative/persistent game server. Do not expose registration publicly until
these gaps and deployment security are addressed.

Integration tests require a **disposable** PostgreSQL database whose name ends
in `_test`, with both SQL scripts applied:

```sh
cd server
TEST_DATABASE_URL="$DATABASE_URL" npm test
```

Without `TEST_DATABASE_URL`, database integration tests are skipped.

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
