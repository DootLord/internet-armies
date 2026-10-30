import { describe, expect, it } from 'vitest';
import { computeStats, emptyFit } from '../ships/fitting';
import { FLIGHT, newFlight, stepFlight } from '../ships/flight';
import { BOOST_BURN, dryFlight, FUEL_BURN, fuelBurn, fullVitals, refitVitals } from '../ships/vitals';

describe('ship vitals', () => {
  it('burns fuel with throttle, faster when boosting, none when coasting', () => {
    expect(fuelBurn({ throttle: 1, steer: 0, boost: false }, 1)).toBe(FUEL_BURN);
    expect(fuelBurn({ throttle: 1, steer: 0, boost: true }, 1)).toBe(BOOST_BURN);
    expect(fuelBurn({ throttle: 0, steer: 1, boost: false }, 1)).toBe(0);
  });

  it('keeps a dry ship moving, just very slowly', () => {
    const s = newFlight(0, 0, 0);
    for (let i = 0; i < 600; i++) stepFlight(s, { throttle: 1, steer: 0, boost: true }, 1 / 120, dryFlight(FLIGHT));
    expect(s.vx).toBeGreaterThan(0);
    expect(s.vx).toBeLessThan(FLIGHT.maxSpeed * 0.25);
  });

  it('keeps health and fuel fractions across a hull swap', () => {
    const v = fullVitals(computeStats('wisp', emptyFit('wisp')));
    v.hp /= 2;
    v.fuel /= 4;
    const next = refitVitals(v, computeStats('bastion', emptyFit('bastion')));
    expect(next.hp / next.maxHp).toBeCloseTo(0.5);
    expect(next.fuel / next.maxFuel).toBeCloseTo(0.25);
  });
});
