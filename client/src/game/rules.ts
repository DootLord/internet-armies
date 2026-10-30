// Game rules shared verbatim by client (instant placement feedback) and shard
// (authoritative). They read the world through WorldRead, so they don't care
// whether the data is a client chunk cache or the shard's own state.
import { FACTIONS, Res, RES_INFO, RES_KEYS, STRUCT, StructureKind, TILE_INFO, TileKind } from './defs';
import { neighbor } from './hex';
import type { BuildCheck, Structure } from './protocol';

export interface WorldRead {
  /** null = not known (chunk not loaded). */
  kind(col: number, row: number): TileKind | null;
  owner(col: number, row: number): number;
  structure(col: number, row: number): Structure | null;
}

export function isAdjacentTo(w: WorldRead, col: number, row: number, f: number) {
  for (let d = 0; d < 6; d++) if (w.owner(...neighbor(col, row, d)) === f) return true;
  return false;
}

export function canBuild(w: WorldRead, kind: StructureKind, col: number, row: number, f: number, res?: Res): BuildCheck {
  const tk = w.kind(col, row);
  const def = STRUCT[kind];
  if (tk === null) return { ok: false, reason: 'Sector data still loading' };
  if (tk === 'void') return { ok: false, reason: 'No solid ground' };
  if (w.structure(col, row)) return { ok: false, reason: 'Sector occupied' };
  if (def.place === 'none') return { ok: false, reason: 'Cannot be built' };
  const owner = w.owner(col, row);
  if (def.place === 'frontier') {
    if (owner === f) return { ok: false, reason: 'Must be outside your borders' };
    if (owner !== -1) return { ok: false, reason: `Claimed by ${FACTIONS[owner].name}` };
    if (!isAdjacentTo(w, col, row, f)) return { ok: false, reason: 'Must border your territory' };
  } else {
    if (owner === -1) return { ok: false, reason: 'Outside your territory' };
    if (owner !== f) return { ok: false, reason: `Claimed by ${FACTIONS[owner].name}` };
    if (def.place === 'deposit' && !TILE_INFO[tk as TileKind].deposit) return { ok: false, reason: 'Requires a resource deposit' };
  }
  if (res) for (const k of RES_KEYS) if (res[k] < (def.cost[k] ?? 0)) return { ok: false, reason: `Insufficient ${RES_INFO[k].name.toLowerCase()}` };
  return { ok: true };
}
