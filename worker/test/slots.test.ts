import { describe, expect, it } from 'vitest';

import { type Busy, computeSlots, parseDays, wallTimeToUtcMs } from '../src/slots';

const TZ = 'America/New_York';
const PAST = 0; // nowMs far in the past so nothing is dropped as "past"

function base(over: Partial<Parameters<typeof computeSlots>[1]> = {}) {
  return {
    fromDate: '2026-06-22', // a Monday
    toDate: '2026-06-22',
    tz: TZ,
    durationMin: 60,
    stepMin: 60,
    workStart: '09:00',
    workEnd: '12:00',
    days: [1],
    nowMs: PAST,
    maxSlots: 1000,
    ...over,
  };
}

describe('wallTimeToUtcMs (DST correctness)', () => {
  it('summer EDT (-4): 09:00 -> 13:00Z', () => {
    expect(new Date(wallTimeToUtcMs(2026, 6, 22, 9, 0, TZ)).toISOString()).toBe(
      '2026-06-22T13:00:00.000Z',
    );
  });
  it('winter EST (-5): 09:00 -> 14:00Z', () => {
    expect(new Date(wallTimeToUtcMs(2026, 1, 5, 9, 0, TZ)).toISOString()).toBe(
      '2026-01-05T14:00:00.000Z',
    );
  });
});

describe('computeSlots', () => {
  it('generates working-hour slots in UTC', () => {
    const slots = computeSlots([], base());
    expect(slots.map((s) => s.start)).toEqual([
      '2026-06-22T13:00:00.000Z',
      '2026-06-22T14:00:00.000Z',
      '2026-06-22T15:00:00.000Z',
    ]);
    expect(slots[0].end).toBe('2026-06-22T14:00:00.000Z');
  });

  it('removes slots overlapping a busy block', () => {
    const busy: Busy[] = [{ start: '2026-06-22T14:00:00Z', end: '2026-06-22T14:30:00Z' }];
    const slots = computeSlots(busy, base());
    // 13:00 free, 14:00 overlaps busy -> dropped, 15:00 free.
    expect(slots.map((s) => s.start)).toEqual([
      '2026-06-22T13:00:00.000Z',
      '2026-06-22T15:00:00.000Z',
    ]);
  });

  it('respects 30-min step and duration', () => {
    const slots = computeSlots([], base({ durationMin: 30, stepMin: 30, workEnd: '10:00' }));
    expect(slots.map((s) => s.start)).toEqual([
      '2026-06-22T13:00:00.000Z',
      '2026-06-22T13:30:00.000Z',
    ]);
  });

  it('excludes non-allowed weekdays', () => {
    // 2026-06-20 is a Saturday; with weekdays-only there are no slots.
    const slots = computeSlots([], base({ fromDate: '2026-06-20', toDate: '2026-06-20' }));
    expect(slots).toEqual([]);
  });

  it('drops slots starting before now', () => {
    const nowMs = Date.parse('2026-06-22T14:00:00Z'); // 10:00 EDT
    const slots = computeSlots([], base({ nowMs }));
    expect(slots.map((s) => s.start)).toEqual([
      '2026-06-22T14:00:00.000Z',
      '2026-06-22T15:00:00.000Z',
    ]);
  });

  it('spans multiple days across the range', () => {
    const slots = computeSlots([], base({ toDate: '2026-06-23', days: [1, 2], workEnd: '10:00' }));
    // Mon 22 + Tue 23, one 09:00 slot each.
    expect(slots.map((s) => s.start)).toEqual([
      '2026-06-22T13:00:00.000Z',
      '2026-06-23T13:00:00.000Z',
    ]);
  });
});

describe('parseDays', () => {
  it('parses ranges and lists', () => {
    expect(parseDays('1-5')).toEqual([1, 2, 3, 4, 5]);
    expect(parseDays('0,6')).toEqual([0, 6]);
    expect(parseDays('5-6,1')).toEqual([1, 5, 6]);
  });
  it('throws on garbage', () => {
    expect(() => parseDays('abc')).toThrow();
  });
});

// --- Hardening: bound WORK, not just output -------------------------------
// These guard the DoS fixes. `maxSlots` only ever bounded the OUTPUT: past and
// busy candidates `continue` before anything is pushed, so a far-future toDate
// kept the day cursor spinning with the slot count stuck at zero.
describe('computeSlots resource bounds', () => {
  it('terminates on a far-future toDate that yields no slots', () => {
    const t0 = Date.now();
    // Every candidate is dropped as "past", so the slot cap can never trip.
    const slots = computeSlots([], base({ toDate: '9999-12-31', nowMs: Date.parse('2100-01-01T00:00:00Z') }));
    expect(slots).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('terminates when no weekday is allowed (inner loop never runs)', () => {
    const t0 = Date.now();
    const slots = computeSlots([], base({ toDate: '9999-12-31', days: [] }));
    expect(slots).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('caps the day scan rather than walking to the requested end date', () => {
    // Weekly Mondays over ~8000 years would be ~417k slots without the cap.
    const slots = computeSlots([], base({ toDate: '9999-12-31', maxSlots: 1_000_000 }));
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.length).toBeLessThan(5000);
  });
});

describe('date validation', () => {
  it('rejects regex-valid but calendar-invalid dates', () => {
    // The exact string that bypassed the caller's range clamp via Date.parse NaN.
    expect(() => computeSlots([], base({ toDate: '9999-99-99' }))).toThrow();
    expect(() => computeSlots([], base({ fromDate: '2026-02-30' }))).toThrow();
    expect(() => computeSlots([], base({ fromDate: '2026-13-01' }))).toThrow();
    expect(() => computeSlots([], base({ fromDate: '2026-00-10' }))).toThrow();
  });

  it('still accepts real leap-day dates', () => {
    expect(() => computeSlots([], base({ fromDate: '2028-02-29', toDate: '2028-02-29', days: [2] }))).not.toThrow();
  });
});

describe('errors do not reflect caller input', () => {
  // These messages reach unauthenticated clients and LLM contexts verbatim, so
  // echoing input would launder attacker-controlled text into trusted output.
  const marker = 'IGNORE-PREVIOUS-INSTRUCTIONS';
  it('parseDays omits the offending spec', () => {
    expect(() => parseDays(marker)).toThrow(/^(?!.*IGNORE-PREVIOUS).*$/);
  });
  it('date errors omit the offending value', () => {
    expect(() => computeSlots([], base({ fromDate: marker }))).toThrow(/^(?!.*IGNORE-PREVIOUS).*$/);
  });
});
