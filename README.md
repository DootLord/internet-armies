# Internet Armies

A persistent, single-shard sci-fi territory builder: every player builds on the same hex cluster.

## Layout

```
client/   React + Vite + TypeScript front end (WebGL2 renderer)
server/   (next) Node + Express + socket.io authoritative world
```

## Run the client

```
cd client
npm install
npm run dev        # http://localhost:5173
```

Deep links: `?at=col,row&zoom=4`, or `?at=f2` to jump to a faction's home.

## How rendering works

- `game/sprites.ts` paints all pixel art procedurally into a **colour** layer and an **emissive** layer.
- `game/engine.ts` draws the visible world each frame into four small "art-resolution" canvases:
  background (nebula + parallax stars), colour, emissive, and a light map.
- `game/post.ts` (WebGL2) lights the colour layer with the light map, blooms everything bright,
  upscales with sharp-bilinear filtering (crisp pixels, smooth sub-pixel camera), then tone-maps,
  grades, adds vignette, chromatic fringe and grain.

## Where the server plugs in

`game/world.ts` is the client-side stand-in for the shard: generation, territory, build validation,
construction timers, resource ticks and placeholder AI factions. When the server lands, that logic moves
server-side and the client mirrors state over socket.io; `canBuild` stays on the client for instant
placement feedback.
