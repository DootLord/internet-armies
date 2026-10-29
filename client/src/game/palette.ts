export type RGB = [number, number, number];

export const hex = (h: string): RGB => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
export const ramp = (...h: string[]) => h.map(hex);
export const mix = (a: RGB, b: RGB, t: number): RGB => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];
export const css = (c: RGB, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
export const lum = (c: RGB) => (c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11) / 255;

const INK: RGB = [4, 6, 12];
const WHITE: RGB = [255, 255, 255];
/** 5-step ramp from a faction colour: [deep, dark, base, light, hot]. */
export const accentRamp = (c: RGB): RGB[] => [mix(INK, c, 0.25), mix(INK, c, 0.55), c, mix(c, WHITE, 0.4), mix(c, WHITE, 0.78)];

// Material ramps (dark -> light). Cool gunmetal with a hint of blue, EVE-style.
export const STEEL = ramp('#06080e', '#0d121d', '#161d2b', '#212b3e', '#2f3c54', '#435270', '#5d6f8e', '#8698b4', '#b9c8dc');
export const ROCK = ramp('#08070b', '#121016', '#1c1820', '#27212a', '#342b35', '#443842', '#574852', '#6e5d66');
export const ICE = ramp('#0a1322', '#112038', '#1a3150', '#26476b', '#376289', '#5084a8', '#77abc8', '#acd3e6', '#e6f7ff');
export const CRY = ramp('#05222b', '#0a3f4b', '#0f6371', '#17909b', '#2cc3c9', '#7becea', '#dcfffb');
export const GAS = ramp('#0d0814', '#170e22', '#22142f', '#2e1b3e', '#3d2450', '#523066', '#6c3f80');
export const ORE = ramp('#3a1606', '#6b2a0a', '#a8460f', '#e0701c', '#ffa245', '#ffd890');
export const RUST = ramp('#24100b', '#3f1b10', '#5f2a15', '#83401d');
export const PANEL = ramp('#070b18', '#0c1428', '#13203f', '#1c2f5a', '#2a4579', '#3f63a0', '#6d93cc', '#b0ccf0');

export const OUTLINE: RGB = [4, 5, 10];
export const C_WHITE = WHITE;
export const C_AMBER = hex('#ffa64a');
export const C_VENT = hex('#c46bff');
export const C_CYAN = hex('#59f2ff');
export const C_RED = hex('#ff3b4e');
