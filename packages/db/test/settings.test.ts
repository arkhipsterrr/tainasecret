import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate } from '../src/connection.ts';
import { SettingsRepo } from '../src/repositories/settings.ts';

const now = () => '2026-09-13T00:00:00.000Z';
const defaults = { rubPerJpy: 0.68, markup: 0, planFeeJpy: 400 };

describe('SettingsRepo', () => {
  let repo: SettingsRepo;
  beforeEach(() => { const db = openDb(':memory:'); migrate(db); repo = new SettingsRepo(db, now); });

  it('returns defaults when nothing is stored', () => {
    expect(repo.getPricing(defaults)).toEqual(defaults);
  });

  it('overrides individual pricing keys, keeping defaults for the rest', () => {
    repo.set('rate', '0.7');
    repo.set('markup', '0.1');
    expect(repo.getPricing(defaults)).toEqual({ rubPerJpy: 0.7, markup: 0.1, planFeeJpy: 400 });
  });

  it('set is an upsert (last value wins)', () => {
    repo.set('fee', '400');
    repo.set('fee', '500');
    expect(repo.get('fee')).toBe('500');
    expect(repo.getPricing(defaults).planFeeJpy).toBe(500);
  });

  it('falls back to the default for a non-numeric stored value', () => {
    repo.set('rate', 'garbage');
    expect(repo.getPricing(defaults).rubPerJpy).toBe(0.68);
  });
});

describe('SettingsRepo per-user pricing', () => {
  let repo: SettingsRepo;
  beforeEach(() => { const db = openDb(':memory:'); migrate(db); repo = new SettingsRepo(db, now); });

  it('getPricingFor equals the global effective pricing when the user has no overrides', () => {
    repo.set('rate', '0.7'); // a global override
    expect(repo.getPricingFor(1, defaults)).toEqual(repo.getPricing(defaults));
  });

  it('layers a per-user override over the global/default value', () => {
    repo.setUser(1, 'markup', '0.3');
    expect(repo.getPricingFor(1, defaults).markup).toBe(0.3);
    // a different user is unaffected
    expect(repo.getPricingFor(2, defaults).markup).toBe(defaults.markup);
  });

  it('resolves each knob independently: user > global > default', () => {
    repo.set('rate', '0.7');       // global rate override
    repo.setUser(1, 'markup', '0.25'); // personal markup
    // rate from global, markup personal, fee from default
    expect(repo.getPricingFor(1, defaults)).toEqual({ rubPerJpy: 0.7, markup: 0.25, planFeeJpy: 400 });
  });

  it('clearUser removes a personal override, falling back to global/default', () => {
    repo.setUser(1, 'markup', '0.3');
    repo.clearUser(1, 'markup');
    expect(repo.getPricingFor(1, defaults).markup).toBe(defaults.markup);
  });

  it('getUserOverrides reports only the keys the user has set', () => {
    repo.setUser(1, 'markup', '0.3');
    repo.setUser(1, 'fee', '500');
    expect(repo.getUserOverrides(1)).toEqual({ markup: 0.3, fee: 500 });
  });

  it('ignores a non-numeric per-user value, falling back to global/default', () => {
    repo.setUser(1, 'rate', 'garbage');
    expect(repo.getPricingFor(1, defaults).rubPerJpy).toBe(defaults.rubPerJpy);
    expect(repo.getUserOverrides(1)).toEqual({});
  });

  it('setUser is an upsert (last value wins)', () => {
    repo.setUser(1, 'fee', '500');
    repo.setUser(1, 'fee', '600');
    expect(repo.getUserOverrides(1)).toEqual({ fee: 600 });
  });
});
