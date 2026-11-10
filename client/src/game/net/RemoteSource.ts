// The real WorldSource: the same interface LocalShard implements, over a
// WebSocket to the gateway. Pushes arrive as the shard's MessagePack bytes and
// go through the same dispatch() as in-process ones, so WorldView can't tell
// the difference.
import { io, Socket } from 'socket.io-client';
import { decode } from '@eden/shared/codec';
import type { StructureKind } from '@eden/shared/defs';
import { dispatch } from '@eden/shared/protocol';
import type { BuildCheck, CacheResult, CargoOp, FireOrder, Push, ShipReport, SourceHandlers, WorldMeta, WorldSource } from '@eden/shared/protocol';
import type { Fit } from '@eden/shared/ships/fitting';
import { signIn } from './auth';

export class RemoteSource implements WorldSource {
  private socket: Socket | null = null;
  /** Server clock minus local clock, in seconds. */
  private offset = 0;
  onStatus: (s: 'connecting' | 'online' | 'offline') => void = () => {};

  async connect(h: SourceHandlers): Promise<WorldMeta> {
    this.onStatus('connecting');
    const socket = io({
      path: '/socket.io',
      transports: ['websocket'],
      // Fetched on every (re)connect, so an expired token is simply replaced.
      auth: (cb) => void signIn().then((me) => cb({ token: me.token }), () => cb({})),
    });
    this.socket = socket;
    socket.on('m', (buf: ArrayBuffer) => dispatch(h, decode<Push>(new Uint8Array(buf))));
    // The shard restarted and may have rolled back a moment: start clean.
    socket.on('reset', () => location.reload());
    socket.on('disconnect', () => this.onStatus('offline'));

    const join = async (): Promise<WorldMeta> => {
      const sent = performance.now() / 1000;
      const meta = (await socket.emitWithAck('join')) as WorldMeta | { error: string };
      if ('error' in meta) throw new Error(meta.error);
      // Assume the reply took half the round trip to come back.
      const back = performance.now() / 1000;
      this.offset = meta.now + (back - sent) / 2 - back;
      return meta;
    };
    await new Promise<void>((res, rej) => {
      socket.once('connect', () => res());
      socket.once('connect_error', (e) => rej(e));
    });
    const meta = await join();
    this.onStatus('online');
    // After a dropped connection, socket.io reconnects by itself; our state may have gone stale, so reload.
    socket.io.on('reconnect', () => location.reload());
    return meta;
  }

  now() {
    return performance.now() / 1000 + this.offset;
  }

  subscribe(keys: number[]) {
    this.socket?.emit('sub', keys);
  }
  unsubscribe(keys: number[]) {
    this.socket?.emit('unsub', keys);
  }
  report(ship: ShipReport) {
    this.socket?.volatile.emit('pos', ship.x, ship.y);
  }

  private async ask<T = BuildCheck>(op: string, ...args: unknown[]): Promise<T> {
    if (!this.socket?.connected) return { ok: false, reason: 'Not connected' } as T;
    try {
      return (await this.socket.timeout(8000).emitWithAck('i', op, args)) as T;
    } catch {
      return { ok: false, reason: 'No answer from the server' } as T;
    }
  }

  build(kind: StructureKind, col: number, row: number) {
    return this.ask('build', kind, col, row);
  }
  demolish(col: number, row: number) {
    return this.ask('demolish', col, row);
  }
  fire(order: FireOrder | null) {
    return this.ask('fire', order);
  }
  deploy(bay: number, target: number) {
    return this.ask('deploy', bay, target);
  }
  cargo(op: CargoOp, ship: ShipReport) {
    return this.ask('cargo', op, ship);
  }
  openCache(col: number, row: number, ship: ShipReport) {
    return this.ask<CacheResult>('openCache', col, row, ship);
  }
  board(shipId: number, ship: ShipReport) {
    return this.ask('board', shipId, ship);
  }
  refit(shipId: number, fit: Fit, ship: ShipReport) {
    return this.ask('refit', shipId, fit, ship);
  }
}
