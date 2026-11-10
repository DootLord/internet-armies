// The binary encoding for everything on the wire (bus and socket): MessagePack,
// with typed arrays kept intact so chunk ownership grids stay Int32Arrays.
// Client and servers must agree on these options, which is why it lives here.
import { Packr } from 'msgpackr';

const packr = new Packr({ useRecords: false, moreTypes: true });

export const encode = (v: unknown): Uint8Array => packr.pack(v);
export const decode = <T = unknown>(b: Uint8Array): T => packr.unpack(b) as T;
