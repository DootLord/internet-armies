// Dev-only: renders every hull at a spread of headings for art iteration.
// Open http://localhost:5173/ships.html while `npm run dev` is running.
import { HULLS, hullSprites } from '../game/ships/hulls';
import { YAW_STEPS } from '../game/ships/voxel';

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
