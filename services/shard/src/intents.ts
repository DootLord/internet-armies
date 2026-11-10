// The shard's trust boundary. Intents arrive from browsers we don't control, by
// way of the gateway (which vouches only for *who* sent them). Every argument
// is parsed against a schema before the simulation sees it: wrong types, NaN,
// huge arrays or unknown ops are refused here, so Sector code can assume
// well-formed input and only has to judge whether the move is *allowed*.
import { z } from 'zod';
import { STRUCTURES } from '@eden/shared/defs';
import type { BuildCheck } from '@eden/shared/protocol';
import type { Sector } from '@eden/shared/sim/Sector';
import type { Fit } from '@eden/shared/ships/fitting';

const int = z.number().int().min(-1e7).max(1e7);
const coord = z.number().min(-1e6).max(1e6);
const pos = z.object({ x: coord, y: coord });
const kind = z.enum(STRUCTURES.map((s) => s.kind) as [string, ...string[]]);
const slotList = z.array(z.string().max(40).nullable()).max(12);
const fit = z.object({ high: slotList, mid: slotList, low: slotList });
const container = z.union([z.object({ ship: int }), z.object({ store: int })]);
const cargoOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('move'), from: container, uid: int, to: container, x: int, y: int, rot: z.boolean() }),
  z.object({ op: z.literal('jettison'), from: container, uid: int }),
]);
const fireOrder = pos.extend({ target: int, unit: z.boolean().optional() });

type Handler = (s: Sector, empire: number, args: never) => BuildCheck;
const intent = <T extends z.ZodType>(schema: T, run: (s: Sector, empire: number, args: z.infer<T>) => BuildCheck) => ({ schema, run: run as Handler });

export const INTENTS: Record<string, { schema: z.ZodType; run: Handler }> = {
  build: intent(z.tuple([kind, int, int]), (s, e, [k, c, r]) => s.build(e, k as never, c, r)),
  demolish: intent(z.tuple([int, int]), (s, e, [c, r]) => s.demolish(e, c, r)),
  fire: intent(z.tuple([fireOrder.nullable()]), (s, e, [o]) => s.fire(e, o)),
  deploy: intent(z.tuple([int, int]), (s, e, [bay, target]) => s.deploy(e, bay, target)),
  cargo: intent(z.tuple([cargoOp, pos]), (s, e, [op, at]) => s.cargo(e, op, at)),
  openCache: intent(z.tuple([int, int, pos]), (s, e, [c, r, at]) => s.openCache(e, c, r, at)),
  board: intent(z.tuple([int, pos]), (s, e, [id, at]) => s.board(e, id, at)),
  refit: intent(z.tuple([int, fit, pos]), (s, e, [id, f, at]) => s.refit(e, id, f as Fit, at)),
};

/** Parse and run one intent. Never throws for bad input; answers with a refusal instead. */
export function runIntent(s: Sector, empire: number, op: string, args: unknown): BuildCheck {
  const h = Object.hasOwn(INTENTS, op) ? INTENTS[op] : undefined;
  if (!h) return { ok: false, reason: 'Unknown action' };
  const parsed = h.schema.safeParse(args);
  if (!parsed.success) return { ok: false, reason: 'Malformed request' };
  return h.run(s, empire, parsed.data as never);
}
