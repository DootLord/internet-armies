import { describe, expect, it } from 'vitest';
import { autopilot, FLIGHT, newFlight, stepFlight } from '../ships/flight';

const run = (seconds: number, f: (t: number) => void) => {
  for (let t = 0; t < seconds; t += 1 / 120) f(t);
};

describe('flight model', () => {
  it('accelerates forward and respects the speed cap', () => {
    const s = newFlight(0, 0, 0);
    run(5, () => stepFlight(s, { throttle: 1, steer: 0, boost: false }, 1 / 120));
    expect(s.vx).toBeGreaterThan(FLIGHT.maxSpeed * 0.95);
    expect(Math.hypot(s.vx, s.vy)).toBeLessThanOrEqual(FLIGHT.maxSpeed + 1);
    expect(Math.abs(s.vy)).toBeLessThan(1e-6);
  });

  it('boost raises the cap, and the excess bleeds off afterwards', () => {
    const s = newFlight(0, 0, 0);
    run(4, () => stepFlight(s, { throttle: 1, steer: 0, boost: true }, 1 / 120));
    expect(s.vx).toBeGreaterThan(FLIGHT.maxSpeed * 1.5);
    run(4, () => stepFlight(s, { throttle: 1, steer: 0, boost: false }, 1 / 120));
    expect(s.vx).toBeLessThan(FLIGHT.maxSpeed * 1.05);
  });

  it('banks into turns and levels out after', () => {
    const s = newFlight(0, 0, 0);
    run(1, () => stepFlight(s, { throttle: 1, steer: 1, boost: false }, 1 / 120));
    expect(s.bank).toBeGreaterThan(0.6);
    run(2, () => stepFlight(s, { throttle: 1, steer: 0, boost: false }, 1 / 120));
    expect(Math.abs(s.bank)).toBeLessThan(0.05);
  });

  it('is deterministic for identical inputs', () => {
    const a = newFlight(10, 20, 1), b = newFlight(10, 20, 1);
    run(3, (t) => {
      const input = { throttle: Math.sin(t), steer: Math.cos(t * 2), boost: t > 1 };
      stepFlight(a, input, 1 / 120);
      stepFlight(b, input, 1 / 120);
    });
    expect(b).toEqual(a);
  });

  it('autopilot reaches a target behind it and stops there', () => {
    const s = newFlight(0, 0, 0);
    let arrived = false;
    run(20, () => {
      if (arrived) return;
      const input = autopilot(s, -400, 250);
      if (!input) arrived = true;
      else stepFlight(s, input, 1 / 120);
    });
    expect(arrived).toBe(true);
    expect(Math.hypot(s.x + 400, s.y - 250)).toBeLessThan(10);
  });
});
