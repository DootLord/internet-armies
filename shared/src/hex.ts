// Pointy-top hexes, odd-r offset layout, rasterised with clean 2:1 pixel-art edges.
//   face: 32 x 28 px, rows step 21 px, odd rows shift right 16 px.
export const TW = 32;
export const FH = 28;
export const RH = 21;
export const CX = 16;
export const CY = 14;

const dxi = (x: number) => (x < 16 ? 15 - x : x - 16);
export const topY = (x: number) => dxi(x) >> 1;
export const botY = (x: number) => FH - (dxi(x) >> 1); // exclusive
export const inFace = (x: number, y: number) => x >= 0 && x < TW && y >= topY(x) && y < botY(x);
export const edgeDist = (x: number, y: number) => Math.min(y - topY(x), botY(x) - 1 - y, x, TW - 1 - x);

export const tileX = (col: number, row: number) => col * TW + (row & 1) * 16;
export const tileY = (row: number) => row * RH;

// Direction order: NE, E, SE, SW, W, NW (matches edge order in sprites).
const DIRS_EVEN = [[0, -1], [1, 0], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
const DIRS_ODD = [[1, -1], [1, 0], [1, 1], [0, 1], [-1, 0], [0, -1]];
export function neighbor(col: number, row: number, dir: number): [number, number] {
  const d = (row & 1 ? DIRS_ODD : DIRS_EVEN)[dir];
  return [col + d[0], row + d[1]];
}

const toQ = (col: number, row: number) => col - ((row - (row & 1)) >> 1);
export function hexDist(c1: number, r1: number, c2: number, r2: number) {
  const dq = toQ(c1, r1) - toQ(c2, r2), dr = r1 - r2;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

export function hexesInRadius(col: number, row: number, rad: number): [number, number][] {
  const out: [number, number][] = [];
  const q0 = toQ(col, row);
  for (let dq = -rad; dq <= rad; dq++) {
    for (let dr = Math.max(-rad, -dq - rad); dr <= Math.min(rad, -dq + rad); dr++) {
      const q = q0 + dq, r = row + dr;
      out.push([q + ((r - (r & 1)) >> 1), r]);
    }
  }
  return out;
}

/** World pixel -> tile (col,row), testing the exact rasterised face. */
export function pick(wx: number, wy: number): [number, number] | null {
  const fx = Math.floor(wx), fy = Math.floor(wy);
  const r0 = Math.floor(fy / RH);
  for (const r of [r0, r0 - 1]) {
    const c = Math.floor((fx - (r & 1) * 16) / TW);
    if (inFace(fx - tileX(c, r), fy - tileY(r))) return [c, r];
  }
  return null;
}

/** Which edge (0..5, NE..NW) a boundary pixel of the face belongs to. */
export function edgeOf(x: number, y: number): number {
  const ax = x + 0.5 - CX, ay = (y + 0.5 - CY) * 1.32;
  const ang = (Math.atan2(ay, ax) * 180) / Math.PI;
  return Math.floor(((((ang + 90) % 360) + 360) % 360) / 60) % 6;
}
