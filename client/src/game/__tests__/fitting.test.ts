import { describe, expect, it } from 'vitest';
import { autoSlot, canFit, canUnfit, computeStats, emptyFit, fittedModules, flightParams, Fit, withModule } from '../ships/fitting';
import { STARTERS, starterFit } from '../ships/hangar';
import { HULL, HULLS } from '../ships/hulls';

const fitAll = (hull: 'wisp' | 'lancer' | 'bastion' | 'mule', ids: string[]) => {
  let fit: Fit = emptyFit(hull);
  for (const id of ids) {
    const r = autoSlot(hull, fit, id);
    if (!('index' in r)) throw new Error(`${id}: ${r.reason}`);
    fit = withModule(fit, id.match(/laser|driver|pod|lance|beam|arm/) ? 'high' : id.match(/ext|burner|array|tractor|survey/) ? 'mid' : 'low', r.index, id);
  }
  return fit;
};

describe('fitting rules', () => {
  it('empty fits match the hull slot layout', () => {
    const f = emptyFit('bastion');
    expect([f.high.length, f.mid.length, f.low.length]).toEqual([5, 3, 5]);
    expect(computeStats('bastion', f).cpuUsed).toBe(0);
  });

  it('rejects modules in the wrong slot type', () => {
    expect(canFit('lancer', emptyFit('lancer'), 'low', 0, 'pulse-laser')).toMatchObject({ ok: false, reason: 'Needs a high slot' });
  });

  it('enforces the power grid', () => {
    // A Siege Lance needs 190 power; the Wisp only has 48.
    const r = canFit('wisp', emptyFit('wisp'), 'high', 0, 'siege-lance');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/power/);
    expect(canFit('bastion', emptyFit('bastion'), 'high', 0, 'siege-lance').ok).toBe(true);
  });

  it('enforces CPU, and a Co-Processor can make room', () => {
    // Wisp: 120 CPU. Missile Pods 32+32, Sensor Array 22, Tractor 22 = 108 used, 12 free.
    let fit = fitAll('wisp', ['missile-pod', 'missile-pod', 'sensor-array', 'tractor']);
    expect(computeStats('wisp', fit).cpuUsed).toBe(108);
    const r = canFit('wisp', fit, 'mid', 2, 'survey'); // needs 18
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/CPU/);
    // +10% CPU (132 total) makes room for it.
    fit = fitAll('wisp', ['missile-pod', 'missile-pod', 'sensor-array', 'tractor', 'co-processor']);
    expect(canFit('wisp', fit, 'mid', 2, 'survey').ok).toBe(true);
  });

  it('refuses to remove a module others depend on', () => {
    // Bastion: 950 power. Five Siege Lances = 950, plus a Shield Extender (22) only fits with the relay's +12%.
    let fit = fitAll('bastion', ['power-relay', 'siege-lance', 'siege-lance', 'siege-lance', 'siege-lance', 'siege-lance', 'shield-ext']);
    const st = computeStats('bastion', fit);
    expect(st.power).toBeCloseTo(950 * 1.12);
    expect(st.powerUsed).toBe(972);
    expect(canUnfit('bastion', fit, 'low', 0).ok).toBe(false);
    fit = withModule(fit, 'mid', 0, null);
    expect(canUnfit('bastion', fit, 'low', 0).ok).toBe(true);
  });

  it('applies diminishing returns to stacked multipliers', () => {
    const one = computeStats('mule', fitAll('mule', ['hold-expander'])).cargo;
    const two = computeStats('mule', fitAll('mule', ['hold-expander', 'hold-expander'])).cargo;
    const base = HULL.mule.base.cargo;
    expect(one).toBeCloseTo(base * 1.25);
    expect(two).toBeCloseTo(base * 1.25 * (1 + 0.25 * 0.869));
    // The second expander multiplies a bigger hold, so judge by ratio: +21.7% vs +25%.
    expect(two / one).toBeLessThan(one / base);
  });

  it('every starter loadout fits completely and within budget', () => {
    for (const h of HULLS) {
      const fit = starterFit(h.id);
      const st = computeStats(h.id, fit);
      expect(fittedModules(fit).map((m) => m.id).sort()).toEqual([...STARTERS[h.id]].sort());
      expect(st.cpuUsed).toBeLessThanOrEqual(st.cpu);
      expect(st.powerUsed).toBeLessThanOrEqual(st.power);
    }
  });

  it('feeds fitted stats into the flight model', () => {
    const plain = flightParams(computeStats('lancer', emptyFit('lancer')));
    const fast = flightParams(computeStats('lancer', fitAll('lancer', ['afterburner'])));
    expect(plain.maxSpeed).toBe(HULL.lancer.base.maxSpeed);
    expect(fast.maxSpeed).toBeCloseTo(plain.maxSpeed * 1.3);
    expect(fast.boostSpeed).toBeCloseTo(fast.maxSpeed * 1.8);
  });
});
