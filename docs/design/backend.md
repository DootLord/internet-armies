# Backend architecture

Status: **phase 1 built** · 2026-11-10

## Decisions (user, 2026-11-10)

| Question | Decision |
|---|---|
| Services | Gateway + sector shard + accounts. Galaxy service waits for a second sector. |
| Persistence | Hybrid write-behind: world in memory, flushed every 2 s; player intents commit before their ack |
| Sign-in | Guest first, then link Discord / Google. No passwords stored. |
| Movement trust | Client flies, shard validates reports against the hull's top speed |
| Messaging | NATS |
| Deploy | Docker Compose now (local + Coolify), Kubernetes next |
| Players | Players only. AI factions removed; EVE-style NPC pirates come later as their own system |

## Topology

```
browser ──► web (nginx) ─┬─ /              static client
                         ├─ /auth/*        accounts ──────────┐
                         └─ /socket.io     gateway × N         │
                                              │                │
                                            NATS ◄─────────────┤
                                              │                │
                                           shard (1 per sector)│
                                              │                │
                                           Postgres ◄──────────┘
                                   (schema accounts | schema shard)
```

| Service | State | Scales by | Talks to |
|---|---|---|---|
| **web** | none | replicas | proxies to accounts and gateway |
| **accounts** | Postgres (`accounts` schema) | replicas | Postgres, NATS (outbox) |
| **gateway** | sockets only | replicas (WebSocket only, so no sticky sessions) | NATS, accounts JWKS |
| **shard** | the sector, in memory + Postgres (`shard` schema) | one process per sector | NATS, Postgres |

Each service has its own Postgres role that can only touch its own schema.
Services never read each other's tables; they talk over NATS.

## Code layout

```
shared/            game rules + protocol, used by browser and servers alike
  src/sim/Sector.ts   the authoritative simulation (multi-empire, no I/O)
  src/sim/LocalShard.ts  Sector in-process: offline play (?offline) and tests
  src/codec.ts        MessagePack with typed arrays: the wire format
services/kit       logging, env config, Postgres + migrations, NATS subjects, probes, shutdown
services/accounts  guest/OAuth sign-in, sessions, JWT signing, GDPR deletion
services/gateway   socket.io edge: auth, rooms <-> NATS subjects, rate limits
services/shard     Sector + NATS + Postgres store + intent validation
client             React/WebGL; RemoteSource is the network WorldSource
scripts/smoke.ts   end-to-end test against a running stack
```

## How a player action flows

```
click "build"
  client ──socket 'i'──► gateway        token already verified at connect: stamps empire id
  gateway ──NATS request sector.1.intent──► shard
  shard: zod-validate args ─► Sector.build() ─► group-commit to Postgres
  shard ──reply──► gateway ──ack──► client           "ok" only once it's durable
  shard ──publish sector.1.c.<chunk>──► every gateway with a watcher ──► sockets in room c:<chunk>
```

## Fan-out: rooms mirror subjects

Each socket joins socket.io rooms: `p:<empire>`, `all`, and `c:<chunk>` for each
chunk it watches. When a room gets its first member, that gateway subscribes to
the matching NATS subject; when it empties, the gateway unsubscribes. The shard
publishes each change **once**, and NATS delivers it only to gateways that have
someone watching. The gateway forwards the shard's bytes without decoding them.

## Persistence

- **Write-through for intents.** An intent mutates memory, then awaits a flush
  before acknowledging. Flushes are **group-committed**: while one transaction
  runs, every new request shares the single one queued behind it.
- **Write-behind for the simulation.** Construction, health lines, squads and
  position reports flush every `SAVE_INTERVAL_MS` (2 s).
- **One statement per table per flush.** Rows go in as a JSON array and are
  unpacked by `jsonb_to_recordset`.
- **Fail-stop.** If a save fails, the shard exits. Memory and disk would
  otherwise disagree, and a restart reloads the last good state.
- **Restart semantics.** Sector time runs from a stored epoch, so it keeps
  counting while the shard is down. Construction finishes on schedule and
  resources accrue offline. Health drains stop at the last save (nobody was
  firing), and squads resume where they stood.
- **Guards in the schema.** Unique `(sector, col, row)` on structures, and
  one row per item keyed by uid, so a duplication bug fails the save instead of
  minting items.

Verified by `scripts/smoke.ts`: an acknowledged build survives `SIGKILL` of the shard.

## Trust boundaries

| Boundary | Guard |
|---|---|
| Who you are | EdDSA JWT from accounts, verified by the gateway with the public JWKS. The client never names its empire. |
| What you send | Gateway: op whitelist and per-socket token buckets. Shard: zod schema per intent. |
| What's allowed | Sector rules, the same code the client uses for prediction |
| Where you are | Reports must be reachable at boost speed since the last one (×1.5 + 60 px slack), or a respawn next to your own Nexus or Hangar; otherwise a `correct` push snaps you back |
| OAuth | Signed `state` (its own audience) + HttpOnly nonce cookie; only the provider's user id is stored |
| Sessions | Random 256-bit secret per device, stored as SHA-256 only |

## Failure handling

| What dies | What happens |
|---|---|
| A gateway | Its sockets reconnect to another replica. The shard notices the missing heartbeats (30 s) and logs those players out. |
| The shard | Intents time out ("try again"). On restart it publishes `hello`; gateways tell clients to reload. Acknowledged intents were already durable. |
| Accounts | No new sign-ins; existing sockets keep playing (tokens are verified locally). |
| NATS | Clients auto-reconnect and wait; nothing is persisted in NATS. |
| Account deletion mid-flight | Transactional outbox: the deletion and the "erase empire" event commit together. A relay delivers at-least-once until the shard acks; purge is idempotent. |

## Known gaps (next phases)

1. **Kubernetes:** manifests or Helm. Shard as a StatefulSet with one replica per
   sector, gateways as a Deployment + HPA, Ingress replacing nginx routing,
   Secrets, and a managed or operator Postgres.
2. **Observability:** Prometheus metrics (tick time, save latency, intents/s,
   sockets), Grafana dashboards, and log shipping.
3. **Interest management:** squads and the overview still go to everyone in the
   sector; the empire list is sent whole on join.
4. **Other players' flagships are not visible yet.** Positions reach the shard
   but aren't broadcast.
5. **Credits are still per sector.** They move to a global wallet in accounts
   when a second sector opens. That needs a saga or outbox between shard and
   accounts.
6. **Durable cross-sector events:** `accounts.deleted` is request/reply to one
   shard. With several sectors it should move to a JetStream stream that every
   shard consumes.
7. **Signing-key rotation, guest-account expiry, and an account UI** (link,
   rename, delete) in the client.
8. **NPC pirates** as their own system (see memory: bounties and resource drops).
