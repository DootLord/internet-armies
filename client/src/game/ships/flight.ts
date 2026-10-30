// Arcade-Newtonian flight. Pure and deterministic (state + input + dt -> state),
// so the server can later run the exact same step and the client can predict
// ahead of it.

export interface FlightState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Radians; 0 = east, increasing clockwise on screen (y points down). */
  heading: number;
  /** Angular velocity, rad/s. */
  turn: number;
  /** -1..1, visual roll into turns. */
  bank: number;
  /** 0..~1.5, visual engine intensity. */
  thrust: number;
}

export interface FlightInput {
  /** -1 = brake/reverse, 1 = full thrust. */
  throttle: number;
  /** -1 = turn left (anticlockwise), 1 = turn right. */
  steer: number;
  boost: boolean;
  /** Station-keeping: kill all motion without ever reversing (autopilot arrival). */
  hold?: boolean;
}

export interface FlightParams {
  accel: number;
  boostAccel: number;
  maxSpeed: number;
  boostSpeed: number;
  reverseSpeed: number;
  turnRate: number;
  turnAccel: number;
  grip: number;
  drag: number;
  brake: number;
}

/** Defaults (a Lancer with nothing fitted); fitted ships derive theirs in fitting.ts. */
export const FLIGHT: FlightParams = {
  accel: 240,
  boostAccel: 420,
  maxSpeed: 150,
  boostSpeed: 270,
  reverseSpeed: 45,
  turnRate: 2.7,
  turnAccel: 9,
  /** How quickly sideways drift is killed: higher = grippier. */
  grip: 2.4,
  /** Coasting drag when not thrusting. */
  drag: 0.55,
  brake: 2.8,
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export function newFlight(x: number, y: number, heading = 0): FlightState {
  return { x, y, vx: 0, vy: 0, heading, turn: 0, bank: 0, thrust: 0 };
}

export function stepFlight(s: FlightState, input: FlightInput, dt: number, F: FlightParams = FLIGHT) {
  // Rotation: angular velocity eases toward the commanded rate.
  const want = clamp(input.steer, -1, 1) * F.turnRate;
  s.turn += clamp(want - s.turn, -F.turnAccel * dt, F.turnAccel * dt);
  s.heading = wrapAngle(s.heading + s.turn * dt);

  // Work in the ship's frame: "along" = forward speed, "lat" = sideways drift.
  const fx = Math.cos(s.heading), fy = Math.sin(s.heading);
  let along = s.vx * fx + s.vy * fy;
  let lat = -s.vx * fy + s.vy * fx;
  const throttle = clamp(input.throttle, -1, 1);
  const max = input.boost ? F.boostSpeed : F.maxSpeed;
  if (input.hold) {
    along *= Math.exp(-4 * dt);
    lat *= Math.exp(-4 * dt);
  } else if (throttle > 0) {
    // Thrust only pushes up to the cap; it never fights the bleed below.
    if (along < max) along = Math.min(max, along + throttle * (input.boost ? F.boostAccel : F.accel) * dt);
  } else if (throttle < 0) {
    along -= along * Math.min(1, F.brake * -throttle * dt);
    if (along < 4) along = Math.max(-F.reverseSpeed, along - F.accel * 0.3 * -throttle * dt);
  } else along *= Math.exp(-F.drag * dt);
  // Over the cap (e.g. boost released): bleed off smoothly rather than snapping.
  if (along > max) along = max + (along - max) * Math.exp(-3 * dt);
  lat *= Math.exp(-F.grip * dt);

  s.vx = fx * along - fy * lat;
  s.vy = fy * along + fx * lat;
  s.x += s.vx * dt;
  s.y += s.vy * dt;

  s.bank += (clamp(s.turn / F.turnRate, -1, 1) - s.bank) * Math.min(1, 6 * dt);
  const glow = throttle > 0 ? throttle * (input.boost ? 1.5 : 1) : 0.08;
  s.thrust += (glow - s.thrust) * Math.min(1, 10 * dt);
}

/** Steer toward a point and stop on it. Returns null once arrived. */
export function autopilot(s: FlightState, tx: number, ty: number): FlightInput | null {
  const dx = tx - s.x, dy = ty - s.y, dist = Math.hypot(dx, dy);
  const speed = Math.hypot(s.vx, s.vy);
  // Arrival: inside 10 px (a third of a hex) and nearly stopped.
  if (dist < 10) return speed < 8 ? null : { throttle: 0, steer: 0, boost: false, hold: true };
  const diff = wrapAngle(Math.atan2(dy, dx) - s.heading);
  // Proportional steer with damping on the current turn rate (no wobble on arrival).
  const steer = clamp(diff * 2.4 - s.turn * 0.35, -1, 1);
  if (Math.abs(diff) > 1.3) return { throttle: 0.15, steer, boost: false }; // turn mostly on the spot
  // Slow down with `hold`, never negative throttle: near zero speed, brake turns
  // into reverse and the ship would oscillate around the target. Hold decays
  // speed at rate 4/s, so it stops in about speed/4 px.
  const stopDist = speed / 3.2 + 10;
  if (dist <= stopDist) return { throttle: 0, steer, boost: false, hold: true };
  return { throttle: Math.cos(diff), steer, boost: false };
}
