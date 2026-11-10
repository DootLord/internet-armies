// The NATS message bus: connection plus the one list of subjects every service
// agrees on. Subjects are hierarchical, dot-separated names; subscribers can
// wildcard them (`sector.1.c.*`), and NATS routes each message only to the
// subscribers whose interest matches, so a publisher never needs to know who
// (if anyone) is listening.
import { connect, NatsConnection } from '@nats-io/transport-node';
import type { Logger } from './log';

export type Bus = NatsConnection;

export async function bus(servers: string, name: string, log: Logger): Promise<Bus> {
  const nc = await connect({ servers, name, maxReconnectAttempts: -1, reconnectTimeWait: 1000 });
  log.info({ server: nc.getServer() }, 'connected to NATS');
  void (async () => {
    for await (const s of nc.status()) log.info({ status: s.type }, 'NATS status');
  })();
  return nc;
}

/**
 * Every subject in the system. Per sector:
 *
 *   sector.<s>.intent         request/reply   gateway -> shard   a player's action (build, fire...)
 *   sector.<s>.join           request/reply   gateway -> shard   a player connects; reply is WorldMeta
 *   sector.<s>.snapshot       request/reply   gateway -> shard   current state of some chunks
 *   sector.<s>.leave          publish         gateway -> shard   a player disconnects
 *   sector.<s>.pos            publish         gateway -> shard   flagship position reports
 *   sector.<s>.p.<empire>     publish         shard -> gateways  pushes for one empire
 *   sector.<s>.c.<chunk>      publish         shard -> gateways  pushes for one chunk's watchers
 *   sector.<s>.all            publish         shard -> gateways  pushes for everyone in the sector
 *   sector.<s>.hello          publish         shard -> gateways  the shard (re)started: clients must reload
 *
 * Cross-cutting:
 *
 *   gateway.heartbeat         publish         gateway -> shards  "I'm alive and hold these sessions"
 *   accounts.deleted          request/reply   accounts -> shards erase an empire (GDPR); ack = done
 */
export const subj = {
  intent: (s: number) => `sector.${s}.intent`,
  join: (s: number) => `sector.${s}.join`,
  snapshot: (s: number) => `sector.${s}.snapshot`,
  leave: (s: number) => `sector.${s}.leave`,
  pos: (s: number) => `sector.${s}.pos`,
  player: (s: number, empire: number) => `sector.${s}.p.${empire}`,
  chunk: (s: number, ck: number) => `sector.${s}.c.${ck}`,
  all: (s: number) => `sector.${s}.all`,
  hello: (s: number) => `sector.${s}.hello`,
  heartbeat: 'gateway.heartbeat',
  accountDeleted: 'accounts.deleted',
};

/** What a gateway tells the shard about each connected player. */
export interface JoinRequest {
  gateway: string;
  empire: { id: number; name: string; color: number };
}
export interface LeaveMessage {
  gateway: string;
  empire: number;
}
export interface IntentRequest {
  empire: number;
  op: string;
  args: unknown[];
}
export interface PosMessage {
  empire: number;
  x: number;
  y: number;
}
export interface Heartbeat {
  gateway: string;
  /** Empire id -> open sessions on this gateway. */
  sessions: Record<number, number>;
}

/** Claims the accounts service puts in an access token, and the gateway trusts after verifying it. */
export interface TokenClaims {
  /** Account id (uuid). */
  sub: string;
  /** Empire id. */
  emp: number;
  name: string;
  color: number;
}
