import { describe, expect, it } from 'vitest';

import {
  bookingSlotParams,
  isoDate,
  loadPublicBusy,
  narrowDays,
  resolveWindow,
  scheduleConfig,
  utcDateMs,
} from '../src/schedule-config';
import { computeSlots } from '../src/slots';

const NOW = Date.parse('2026-06-22T00:00:00Z'); // Monday

describe('scheduleConfig', () => {
  it('applies the documented owner defaults', () => {
    expect(scheduleConfig({})).toEqual({
      ownerName: 'the owner',
      workTz: 'America/New_York',
      workStart: '08:00',
      workEnd: '18:00',
      days: [1, 2, 3, 4, 5],
      slotMinutes: 30,
      maxRangeDays: 62,
      bookUrl: '/book',
    });
  });

  it('prefers SCHEDULE_WORK_TZ over AVAILCAL_DEFAULT_TZ', () => {
    expect(scheduleConfig({ SCHEDULE_WORK_TZ: 'Europe/Berlin', AVAILCAL_DEFAULT_TZ: 'UTC' }).workTz)
      .toBe('Europe/Berlin');
    expect(scheduleConfig({ AVAILCAL_DEFAULT_TZ: 'UTC' }).workTz).toBe('UTC');
  });

  it('ignores a non-numeric slot length rather than producing NaN', () => {
    expect(scheduleConfig({ SCHEDULE_SLOT_MINUTES: 'abc' }).slotMinutes).toBe(30);
    expect(scheduleConfig({ SCHEDULE_MAX_RANGE_DAYS: '' }).maxRangeDays).toBe(62);
  });
});

// CHARACTERIZATION: pins the grid POST /book re-validates against. If this
// shape changes, previously-offered times start returning 409 at booking time.
describe('bookingSlotParams is the one booking grid', () => {
  const cfg = scheduleConfig({});

  it('matches the params POST /book built inline', () => {
    expect(bookingSlotParams(cfg, '2026-06-22', '2026-06-22', NOW)).toEqual({
      fromDate: '2026-06-22',
      toDate: '2026-06-22',
      tz: 'America/New_York',
      durationMin: 30,
      stepMin: 30,
      workStart: '08:00',
      workEnd: '18:00',
      days: [1, 2, 3, 4, 5],
      nowMs: NOW,
      maxSlots: 2000,
    });
  });

  it('keeps step equal to duration so every start lands on the owner grid', () => {
    const p = bookingSlotParams(scheduleConfig({ SCHEDULE_SLOT_MINUTES: '45' }), '2026-06-22', '2026-06-22', NOW);
    expect(p.stepMin).toBe(p.durationMin);
    expect(p.durationMin).toBe(45);
  });

  it('produces starts that a single-day re-validation also accepts', () => {
    // The property /book depends on: a slot offered over a WIDE window must
    // still be found when re-validated over just its own day.
    const wide = computeSlots([], bookingSlotParams(cfg, '2026-06-22', '2026-06-26', NOW));
    expect(wide.length).toBeGreaterThan(0);
    for (const slot of wide.slice(0, 25)) {
      const day = isoDate(Date.parse(slot.start));
      const sameDay = computeSlots([], bookingSlotParams(cfg, day, day, NOW));
      expect(sameDay.some((s) => s.start === slot.start && s.end === slot.end)).toBe(true);
    }
  });
});

describe('resolveWindow', () => {
  const cfg = scheduleConfig({});

  it('defaults to today plus the caller span', () => {
    expect(resolveWindow(cfg, null, null, NOW, 7)).toEqual({
      fromDate: '2026-06-22', toDate: '2026-06-29', clamped: false,
    });
  });

  it('never scans the past', () => {
    expect(resolveWindow(cfg, '2020-01-01', '2026-06-23', NOW, 7)?.fromDate).toBe('2026-06-22');
  });

  it('never lets to precede from', () => {
    // This guard was missing from the chat clamp before the refactor.
    expect(resolveWindow(cfg, '2026-07-01', '2026-06-01', NOW, 7)).toEqual({
      fromDate: '2026-07-01', toDate: '2026-07-01', clamped: false,
    });
  });

  it('clamps to maxRangeDays and reports it', () => {
    const w = resolveWindow(cfg, '2026-06-22', '2027-06-22', NOW, 7);
    expect(w).toEqual({ fromDate: '2026-06-22', toDate: '2026-08-23', clamped: true });
  });

  it('rejects a calendar-invalid bound instead of skipping the clamp', () => {
    expect(resolveWindow(cfg, null, '9999-99-99', NOW, 7)).toBeNull();
    expect(resolveWindow(cfg, '2026-02-30', null, NOW, 7)).toBeNull();
  });
});

describe('narrowDays', () => {
  const cfg = scheduleConfig({});
  it('defaults to owner policy', () => {
    expect(narrowDays(cfg, null)).toEqual({ days: [1, 2, 3, 4, 5], dropped: false });
  });
  it('narrows and never widens', () => {
    expect(narrowDays(cfg, [1, 2])).toEqual({ days: [1, 2], dropped: false });
    expect(narrowDays(cfg, [0, 6])).toEqual({ days: [], dropped: true });
    expect(narrowDays(cfg, [1, 6])).toEqual({ days: [1], dropped: true });
  });
});

describe('loadPublicBusy fails closed', () => {
  it('reports not-ok when the object is missing', async () => {
    const r = await loadPublicBusy({ get: async () => null }, 'public/freebusy.json');
    expect(r.ok).toBe(false);
    expect(r.busy).toEqual([]);
  });

  it('returns the feed and its upload time when present', async () => {
    const uploaded = new Date('2026-06-22T10:00:00Z');
    const r = await loadPublicBusy(
      { get: async () => ({ json: async () => [{ start: 'a', end: 'b' }], uploaded }) },
      'public/freebusy.json',
    );
    expect(r.ok).toBe(true);
    expect(r.busy).toHaveLength(1);
    expect(r.asOf).toBe('2026-06-22T10:00:00.000Z');
  });
});

describe('utcDateMs', () => {
  it('accepts real dates and rejects overflow', () => {
    expect(utcDateMs('2026-06-22')).toBe(NOW);
    expect(utcDateMs('9999-99-99')).toBeNull();
    expect(utcDateMs('2026-02-30')).toBeNull();
  });
});
