// Health and fuel: what a ship spends while it flies and fights. Pure, like
// flight.ts, so the server can later run the same rules the client predicts.
import { FlightInput, FlightParams } from './flight';
import { ShipStats } from './fitting';

export interface Vitals {
  hp: number;
  maxHp: number;
  fuel: number;
  maxFuel: number;
}

/** Fuel units per second at full throttle; boosting burns several times faster. */
export const FUEL_BURN = 1;
export const BOOST_BURN = 4;
/** On an empty tank the ship limps along on manoeuvring thrusters at this share of its speed. */
export const DRY_SPEED = 0.2;
/** Fuel Depots refuel ships within this many world px, at this share of the tank per second. */
export const DEPOT_RANGE = 80;
export const REFUEL_RATE = 0.3;
/** Repair Bays patch up ships within this range, at this share of max health per second (empty to full in ~17s). */
export const REPAIR_RANGE = 80;
export const REPAIR_RATE = 0.06;

/** One health pool for now; shield, armor and hull can become layers once ships take real damage. */
export const maxHp = (st: ShipStats) => st.shield + st.armor + st.hull;

export const fullVitals = (st: ShipStats): Vitals => ({ hp: maxHp(st), maxHp: maxHp(st), fuel: st.fuel, maxFuel: st.fuel });

/** Refit or hull swap: keep the same fraction of health and fuel against the new maximums. */
export function refitVitals(v: Vitals, st: ShipStats): Vitals {
  const next = fullVitals(st);
  next.hp *= v.maxHp ? v.hp / v.maxHp : 1;
  next.fuel *= v.maxFuel ? v.fuel / v.maxFuel : 1;
  return next;
}

export const fuelBurn = (input: FlightInput, dt: number) => Math.abs(input.throttle) * (input.boost ? BOOST_BURN : FUEL_BURN) * dt;

/** Handling with an empty tank: very slow, no boost, but never stranded. */
export function dryFlight(F: FlightParams): FlightParams {
  return {
    ...F,
    maxSpeed: F.maxSpeed * DRY_SPEED,
    boostSpeed: F.maxSpeed * DRY_SPEED,
    reverseSpeed: F.reverseSpeed * DRY_SPEED,
    accel: F.accel * DRY_SPEED,
    boostAccel: F.accel * DRY_SPEED,
  };
}
