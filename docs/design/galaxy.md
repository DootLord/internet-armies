# Galaxy design: sectors and gates

Status: **draft for review** · 2026-10-29

## Summary

One persistent universe, EVE-style: a **galaxy** of large **sectors**, each a full map like the
current one (~1M hex slots, streamed in chunks), connected by **gates**. Each active sector runs on
its own server process (a "shard"). Gates are the only path between sectors, which makes them the
strategic chokepoints in gameplay and the clean handoff points between servers in the architecture.

## Decisions taken

| Question | Decision |
|---|---|
| One seamless map vs. many | Many large sectors linked by gates |
| Sector size | Large: today's map (~1M slots, ~500k buildable) is one sector |
| Where players build | **Anywhere**: empires can span sectors (see sprawl rules) |
| Galaxy growth | Seeded galaxy generated up front; sectors **unlock** as population needs |
| Safety | **Security tiers**: protected core, lawless frontier |
| Economy | **Hybrid**: credits are global (one wallet per empire); materials are local to each sector |

## Hierarchy

```
Galaxy   seeded graph of sectors + gates        galaxy service (global)
 └ Sector  one disc map, one shard process        sector shard (stateful)
    └ Chunk  32×32 hexes, streamed to clients      (unchanged)
       └ Tile
```

Everything below "Sector" already exists. Today's `LocalShard` *is* a sector shard.

## Galaxy generation and unlocking

- **Generated from one galaxy seed:** e.g. 2,000 sector positions (Poisson-disc scatter in a spiral
  disc). Gates come from a relative-neighbourhood graph, pruned to 2–5 gates per sector, which gives
  a navigable web with real chokepoints and dead ends.
- **Each sector's seed, size and biome mix** derive from the galaxy seed + sector id, so a sector
  costs nothing until it's activated.
- **Security tier** comes from gate-distance to the core: `high` (0–2 jumps), `low` (3–5), `null` (6+).
- **Unlocking:** a sector is *dormant* (exists in the graph, visible on the galaxy map, no process)
  until opened. The galaxy service opens the next high-sec sector when the open high-sec ones pass a
  density threshold (e.g. 60% of starter slots used). Frontier sectors open when an empire's
  expedition first reaches them, or on a population threshold.
- **New players** spawn in the open high-sec sector with the most free starter space.

## Gates

- **Physical structures in a sector**, near its rim and placed on the bearing toward the
  neighbouring sector, so the galaxy's geometry is visible inside each map. Positions are
  deterministic from the galaxy seed, so the client can draw them without asking.
- **Indestructible in high-sec.** In low/null-sec, gates are capturable, and the holder sets tolls
  and access rules. This is the "hold the chokepoint" gameplay.

### Jump handoff

The jump is the *only* cross-server operation, so it gets a clear protocol:

```
client ──jump(gate)──► Sector A shard   validate: unit at gate, cooldown, access rules
Sector A ──transfer(unit, ticket)──► Galaxy service   A removes the unit (now "in transit")
Galaxy ──ticket + B's address──► client
client ──connect(B, ticket)──► Sector B shard   B redeems the ticket once, spawns the unit at its gate
```

The unit belongs to exactly one place at any moment: sector A, "in transit" (held by the galaxy
service), or sector B. If B never redeems the ticket, it expires and the unit returns to A's gate.
Nothing is ever duplicated or lost.

## What moves between sectors (the presence model)

"Build anywhere" still needs gates to matter, so expansion is **physical**:

- You can always **view and manage** any sector where you own something.
- To claim a **new** sector, you send a **constructor** ship through gates. Travel takes time and
  passes through gates other players may control.
- Viewing a sector where you own nothing is limited to what the galaxy map shows (who holds it,
  activity level), unless an ally shares intel.

## Server architecture

| Piece | State | Scales by |
|---|---|---|
| **Gateway** | none | replicas behind a load balancer; authenticates the socket and routes messages to the right sector shard |
| **Sector shard** | sector world (Postgres + memory) | one process per active sector (a Kubernetes StatefulSet later) |
| **Galaxy service** | graph, sector registry, jump tickets | small; leader + replica |
| **Empire service** | accounts, credit wallet, holdings index across sectors | Postgres; stateless replicas |
| **Chat / alliances** | channels, membership | Redis pub/sub |

A client keeps **one socket to the gateway** and tells it which sector it's viewing. The gateway
forwards to that sector's shard. One public endpoint keeps the setup simple on Coolify now and on
Kubernetes later (ingress with sticky routing per sector).

## Economy: global credits, local materials (decided)

- **Credits are global:** one wallet per empire, held by the empire service. Credits are abstract
  money, so they move instantly.
- **Materials are local:** alloy, energy and crystal sit in a stockpile per sector. They move
  between sectors only by **hauling them through gates**.

Consequences:

- **Exactly one cross-server write per credit spend.** A build in sector A asks the empire service
  to debit the wallet. It's one atomic SQL update (`UPDATE wallet SET credits = credits - $cost
  WHERE credits >= $cost`), and the build proceeds only if that succeeds. Material costs are checked
  locally in the shard. To survive a shard crash between the debit and the build, the debit carries
  an **idempotency key** (the build request id), so retrying never charges twice.
- **Credit income** from every sector is batched per shard and credited to the wallet periodically
  (e.g. every few seconds), not per tick, which keeps the empire service's write load flat.
- **Logistics is still gameplay.** Materials have to be hauled through gates, so holding a chokepoint
  can starve an empire's distant holdings of materials (though not of money). This still limits
  sprawl under "build anywhere".
- **New holdings need seeding:** a constructor arrives with starting materials; credits can be spent
  there immediately.
- **Markets (later)** would be per sector for materials, with prices in global credits. Price
  differences between sectors are what make trade routes worth running.

## Sprawl rules (because "anywhere" needs brakes)

- **Upkeep:** each additional sector held costs upkeep that rises with gate-distance from your
  home Nexus (in the spirit of EVE's sovereignty bills).
- **High-sec:** no conquest; claims there are capped per empire, so the core can't be monopolised.
- **Low/null-sec:** no caps, full PvP, richer deposits. The reward for the risk.

## Client changes

Most of the existing work carries over:

1. `WorldSource` gains a `sectorId`; one `WorldView` per sector being viewed. Chunk keys are
   already scoped per source.
2. **Galaxy map:** a new level of detail above the world map. Zooming out of a sector shrinks it
   into its star in the galaxy graph, with tier colours, holder colours and gate lanes.
3. **Gate structure** sprite + jump interaction, with a transition effect (warp tunnel → new
   sector loads behind it).
4. **Empire panel:** holdings across sectors, from the empire service.

## Build order

1. **Galaxy generation** (shared, deterministic, unit-tested like terrain) + galaxy map view.
2. **Multiple local shards** in-process, gates drawn in sectors, the jump handoff simulated with the
   real ticket flow. Tests for "never lost, never duplicated".
3. **Constructor travel** + claiming in other sectors; empire panel.
4. Real servers: gateway + sector shard in Node, then the galaxy and empire services.

## Open questions (deferred, to revisit)

1. **Player presence:** does the player exist as a unit (a commander or flagship) that has to
   travel, or only as an RTS overseer? This decides what "being in a sector" means.
2. **Combat model:** how fighting works at all, including whether units can fight at gates
   (gate camping) or a jump is safe once you reach the gate.
3. Alliance-owned gates: who can change tolls or access rules?
4. Starting galaxy size: is 2,000 sectors (about 1B hex slots in total, mostly dormant) right?

None of these block steps 1–2 of the build order: galaxy generation, the galaxy map, gates and the
jump handoff work the same whatever the answers.
