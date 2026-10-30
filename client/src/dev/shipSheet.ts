// Dev-only: renders every hull at a spread of headings for art iteration.
// Open http://localhost:5173/ships.html while `npm run dev` is running.
import { HULLS, hullSprites } from '../game/ships/hulls';
import { YAW_STEPS } from '../game/ships/voxel';
import { ItemKind, ITEMS } from '../game/ships/cargo';
import { itemPose, itemSpan } from '../game/itemArt';
import { trooperFrame } from '../game/trooperArt';

const cols = YAW_STEPS / 4, scale = 3;
for (const h of HULLS) {
  const S = hullSprites(h.id).size;
  const label = document.createElement('div');
  label.textContent = `${h.name} · ${h.class} · ${S}px`;
  label.style.marginTop = '16px';
  const cv = document.createElement('canvas');
  cv.width = cols * S;
  cv.height = S * 5;
  cv.style.width = `${cv.width * scale}px`;
  const g = cv.getContext('2d')!;
  // Rows: level flight, hard bank right, then damage stages 1-3 in level flight.
  for (const [row, bank, stage] of [[0, 0, 0], [1, -2, 0], [2, 0, 1], [3, 0, 2], [4, 0, 3]])
    for (let i = 0; i < cols; i++) {
      const f = hullSprites(h.id, 0, stage).frame(i * 4, bank);
      g.drawImage(f.color, i * S, row * S);
      g.globalCompositeOperation = 'lighter';
      g.drawImage(f.emit, i * S, row * S);
      g.globalCompositeOperation = 'source-over';
    }
  document.body.append(label, cv);
}

// Cargo items: resting pose, the sway range, and rotated.
const items = document.createElement('div');
items.textContent = 'Cargo items · rest · sway -1 / +1 · rotated';
items.style.marginTop = '24px';
document.body.append(items);
for (const kind of Object.keys(ITEMS) as ItemKind[]) {
  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.gap = '12px';
  row.style.alignItems = 'center';
  for (const [rot, a] of [[false, 0], [false, -1], [false, 1], [true, 0]] as [boolean, number][]) {
    const img = document.createElement('img');
    img.src = itemPose(kind, rot, a);
    img.style.width = `${itemSpan(kind) * 16 * scale}px`;
    img.style.imageRendering = 'pixelated';
    row.append(img);
  }
  const name = document.createElement('span');
  name.textContent = ITEMS[kind].name;
  row.append(name);
  document.body.append(row);
}

// Mechs: 16 of the 32 facings for each pose (stand/fire, then the four-step walk), two factions.
for (const owner of [0, 2]) {
  const first = trooperFrame(owner, 0, 0), S = first.half * 2, dirs = 16;
  const label = document.createElement('div');
  label.textContent = `Mech · faction ${owner} · ${S}px`;
  label.style.marginTop = '16px';
  const cv = document.createElement('canvas');
  cv.width = dirs * S;
  cv.height = S * 5;
  cv.style.width = `${cv.width * 2}px`;
  cv.style.imageRendering = 'pixelated';
  const g = cv.getContext('2d')!;
  for (let pose = 0; pose < 5; pose++)
    for (let i = 0; i < dirs; i++) {
      const { frame } = trooperFrame(owner, pose, (i / dirs) * Math.PI * 2);
      g.drawImage(frame.color, i * S, pose * S);
      g.globalCompositeOperation = 'lighter';
      g.drawImage(frame.emit, i * S, pose * S);
      g.globalCompositeOperation = 'source-over';
    }
  document.body.append(label, cv);
}
