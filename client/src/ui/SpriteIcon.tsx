import { CSSProperties } from 'react';
import { StructureKind } from '../game/defs';
import { assets } from '../game/sprites';

/**
 * A structure portrait rendered like the world: crisp colour layer, emissive
 * layer with a blurred copy for bloom, and a specular glint masked to the
 * bright metal. `k` is the scale relative to one UI pixel.
 */
export function SpriteIcon({ kind, owner = 0, k, glint = 'hover' }: { kind: StructureKind; owner?: number; k: number; glint?: 'hover' | 'loop' }) {
  const shine = `url(${assets.icon(kind, owner, 'shine')})`;
  return (
    <span className={`sprite glint-${glint}`} style={{ '--k': k } as CSSProperties}>
      <img src={assets.icon(kind, owner)} alt="" draggable={false} />
      <img src={assets.icon(kind, owner, 'emit')} alt="" draggable={false} className="emit" />
      <img src={assets.icon(kind, owner, 'bloom')} alt="" draggable={false} className="bloom" />
      <span className="glint" style={{ maskImage: shine, WebkitMaskImage: shine }} />
    </span>
  );
}
