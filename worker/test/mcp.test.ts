import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  type ScheduleConfig,
  type ToolCtx,
  checkSlotAvailable,
  listBusyBlocks,
  listOpenSlots,
  renderBusyText,
  renderSlotsText,
  scheduleConfig,
  schedulingPolicy,
  utcDateMs,
  validTimezone,
} from '../src/mcp';
import { type Busy } from '../src/slots';
import { bookingSlotParams, isoDate } from '../src/schedule-config';
import { slotIsBookable } from '../src/scheduling';

const NOW = Date.parse('2026-06-22T00:00:00Z'); // a Monday

const CFG: ScheduleConfig = {
  ownerName: 'Mendel',
  workTz: 'America/New_York',
  workStart: '09:00',
  workEnd: '12:00',
  days: [1, 2, 3, 4, 5],
  slotMinutes: 30,
  maxRangeDays: 62,
  bookUrl: 'https://availability.example/book',
};

const ctx = (over: Partial<ToolCtx> = {}): ToolCtx => ({
  cfg: CFG,
  busy: [],
  nowMs: NOW,
  ...over,
});

describe('scheduleConfig', () => {
  it('applies the same owner defaults as /slots.json', () => {
    const c = scheduleConfig({});
    expect(c.workTz).toBe('America/New_York');
    expect(c.workStart).toBe('08:00');
    expect(c.workEnd).toBe('18:00');
    expect(c.days).toEqual([1, 2, 3, 4, 5]);
    expect(c.slotMinutes).toBe(30);
    expect(c.maxRangeDays).toBe(62);
  });
});

describe('list_open_slots', () => {
  it('returns UTC instants inside the owner working hours', () => {
    const r = listOpenSlots({ from_date: '2026-06-22', to_date: '2026-06-22' }, ctx());
    // 09:00-12:00 EDT (-4) at 30min = 6 slots, starting 13:00Z.
    expect(r.slots.map((s) => s.start_utc)).toEqual([
      '2026-06-22T13:00:00.000Z',
      '2026-06-22T13:30:00.000Z',
      '2026-06-22T14:00:00.000Z',
      '2026-06-22T14:30:00.000Z',
      '2026-06-22T15:00:00.000Z',
      '2026-06-22T15:30:00.000Z',
    ]);
    expect(r.business_timezone).toBe('America/New_York');
    // business_date/weekday are in the OWNER's zone, not UTC.
    expect(r.slots[0].business_date).toBe('2026-06-22');
    expect(r.slots[0].business_weekday).toBe(1);
  });

  it('removes slots overlapping a busy block', () => {
    const busy: Busy[] = [{ start: '2026-06-22T13:00:00Z', end: '2026-06-22T14:00:00Z' }];
    const r = listOpenSlots({ from_date: '2026-06-22', to_date: '2026-06-22' }, ctx({ busy }));
    expect(r.slots.map((s) => s.start_utc)).not.toContain('2026-06-22T13:00:00.000Z');
    expect(r.slots).toHaveLength(4);
  });

  it('NARROWS the owner weekdays and never widens them', () => {
    // Sunday (0) is not bookable; asking for it must not produce weekend slots.
    const r = listOpenSlots(
      { from_date: '2026-06-21', to_date: '2026-06-27', weekdays: [0, 6] },
      ctx(),
    );
    expect(r.query.weekdays).toEqual([]);
    expect(r.slots).toEqual([]);
    expect(r.notices.join(' ')).toMatch(/outside the owner/i);
  });

  it('intersects a partially-valid weekday request', () => {
    const r = listOpenSlots(
      { from_date: '2026-06-22', to_date: '2026-06-26', weekdays: [1, 6] },
      ctx(),
    );
    expect(r.query.weekdays).toEqual([1]);
    expect(r.slots.every((s) => s.business_weekday === 1)).toBe(true);
  });

  it('clamps an over-long window and says so', () => {
    const r = listOpenSlots({ from_date: '2026-06-22', to_date: '2027-06-22' }, ctx());
    expect(r.query.to_date).toBe('2026-08-23'); // +62d
    expect(r.notices.join(' ')).toMatch(/62-day limit/);
  });

  it('rejects a calendar-invalid date as a tool error', () => {
    expect(() => listOpenSlots({ to_date: '9999-99-99' }, ctx())).toThrow(/real calendar date/);
    expect(() => listOpenSlots({ from_date: '2026-02-30' }, ctx())).toThrow(/real calendar date/);
  });

  it('never scans the past', () => {
    const r = listOpenSlots({ from_date: '2020-01-01', to_date: '2026-06-22' }, ctx());
    expect(r.query.from_date).toBe('2026-06-22');
  });

  it('paginates with an exact cursor and flags truncation', () => {
    const first = listOpenSlots(
      { from_date: '2026-06-22', to_date: '2026-06-22', max_results: 2 },
      ctx(),
    );
    expect(first.returned).toBe(2);
    expect(first.truncated).toBe(true);
    expect(first.next_cursor).toBe('2026-06-22T13:30:00.000Z');

    const second = listOpenSlots(
      { from_date: '2026-06-22', to_date: '2026-06-22', max_results: 2, starting_after_utc: first.next_cursor! },
      ctx(),
    );
    expect(second.slots[0].start_utc).toBe('2026-06-22T14:00:00.000Z');
  });

  it('filters part_of_day in the OWNER timezone', () => {
    // 09:00-12:00 EDT is entirely "morning" by the owner's clock, even though
    // the UTC hours (13:00-16:00) would read as afternoon.
    const morning = listOpenSlots(
      { from_date: '2026-06-22', to_date: '2026-06-22', part_of_day: 'morning' },
      ctx(),
    );
    expect(morning.slots).toHaveLength(6);
    const evening = listOpenSlots(
      { from_date: '2026-06-22', to_date: '2026-06-22', part_of_day: 'evening' },
      ctx(),
    );
    expect(evening.slots).toHaveLength(0);
  });

  it('falls back on an unknown display timezone instead of echoing it', () => {
    const r = listOpenSlots({ from_date: '2026-06-22', display_timezone: 'Mars/Olympus' }, ctx());
    expect(r.display_timezone).toBe('America/New_York');
    expect(r.display_timezone_source).toBe('fallback_business');
  });
});

describe('check_slot_available', () => {
  const day = { from: '2026-06-22' };
  it('confirms a free slot', () => {
    const r = checkSlotAvailable({ start_utc: '2026-06-22T13:00:00.000Z' }, ctx());
    expect(r.available).toBe(true);
    expect(r.reason).toBe('free');
  });

  it('reports a taken slot as busy, not as off-grid', () => {
    const busy: Busy[] = [{ start: '2026-06-22T13:00:00Z', end: '2026-06-22T14:00:00Z' }];
    const r = checkSlotAvailable({ start_utc: '2026-06-22T13:00:00.000Z' }, ctx({ busy }));
    expect(r.available).toBe(false);
    expect(r.reason).toBe('busy');
  });

  it('reports a time outside working hours', () => {
    const r = checkSlotAvailable({ start_utc: '2026-06-22T03:00:00.000Z' }, ctx());
    expect(r.available).toBe(false);
    expect(r.reason).toBe('outside_working_hours');
  });

  it('reports a past instant', () => {
    const r = checkSlotAvailable({ start_utc: '2020-01-01T13:00:00.000Z' }, ctx());
    expect(r.reason).toBe('in_the_past');
  });

  it('rejects a non-instant argument', () => {
    expect(() => checkSlotAvailable({ start_utc: 'next tuesday' }, ctx())).toThrow(/UTC ISO/);
  });

  void day;
});

describe('get_scheduling_policy', () => {
  it('reports owner policy and states it cannot book', () => {
    const r = schedulingPolicy(ctx());
    expect(r.bookable_weekday_names).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);
    expect(r.meeting_length_minutes).toBe(30);
    expect(r.booking.note).toMatch(/cannot book/i);
  });
});

// --- privacy -------------------------------------------------------------
// The public feed is a bare [{start,end}] array. If anyone ever re-points this
// module at the LABELED merged/busy.json, these fail loudly.
describe('privacy: no per-source label can reach a tool result', () => {
  const LEAKY = [
    {
      start: '2026-06-22T13:00:00Z',
      end: '2026-06-22T14:00:00Z',
      source: 'clientacme',
      status: 'busy',
      summary: 'Board review',
      attendees: ['ceo@acme.example'],
      location: 'HQ 12F',
      uid: 'abc-123',
    },
  ] as unknown as Busy[];
  // Values that must never appear anywhere in any rendering.
  const SECRET_VALUES = ['clientacme', 'Board review', 'ceo@acme.example', 'HQ 12F', 'abc-123'];
  // Key names, matched in JSON-quoted form so a legitimate field that merely
  // ENDS in one of them (display_timezone_source) is not a false positive.
  const SECRET_KEYS = ['"source"', '"summary"', '"attendees"', '"location"', '"uid"', '"status"'];

  it('leaks nothing from a labeled busy fixture', () => {
    const c = ctx({ busy: LEAKY });
    const json = [
      JSON.stringify(listOpenSlots({ from_date: '2026-06-22', to_date: '2026-06-22' }, c)),
      JSON.stringify(checkSlotAvailable({ start_utc: '2026-06-22T13:00:00.000Z' }, c)),
      JSON.stringify(schedulingPolicy(c)),
    ].join('\n');
    const blobs = json + '\n' + renderSlotsText(listOpenSlots({ from_date: '2026-06-22', to_date: '2026-06-22' }, c));
    for (const secret of SECRET_VALUES) expect(blobs).not.toContain(secret);
    for (const key of SECRET_KEYS) expect(json).not.toContain(key);
  });

  it('emits an exact whitelist of slot keys', () => {
    const r = listOpenSlots({ from_date: '2026-06-22', to_date: '2026-06-22' }, ctx());
    expect(Object.keys(r.slots[0]).sort()).toEqual([
      'business_date',
      'business_weekday',
      'end_display',
      'end_utc',
      'start_display',
      'start_utc',
    ]);
  });

  it('never names the private labeled feed', () => {
    const src = readFileSync(new URL('../src/mcp.ts', import.meta.url), 'utf8');
    // A quoted literal would mean real code reaching for the private feed; the
    // module's prose may still name it when explaining why it is off limits.
    expect(src).not.toMatch(/['"`]merged\//);
    expect(src).not.toContain('MERGED_BUSY_KEY');
  });
});

describe('helpers', () => {
  it('utcDateMs rejects overflow dates', () => {
    expect(utcDateMs('2026-06-22')).toBe(Date.parse('2026-06-22T00:00:00Z'));
    expect(utcDateMs('9999-99-99')).toBeNull();
    expect(utcDateMs('2026-02-30')).toBeNull();
    expect(utcDateMs('nonsense')).toBeNull();
  });
  it('validTimezone distinguishes real zones', () => {
    expect(validTimezone('Europe/Berlin')).toBe(true);
    expect(validTimezone('Mars/Olympus')).toBe(false);
  });
});

describe('rendering', () => {
  it('pairs each display string with its authoritative UTC instant', () => {
    const r = listOpenSlots({ from_date: '2026-06-22', to_date: '2026-06-22', max_results: 2 }, ctx());
    const text = renderSlotsText(r);
    expect(text).toContain('[2026-06-22T13:00:00.000Z]');
    expect(text).toMatch(/only open times/);
    expect(text).toContain('starting_after_utc');
  });

  it('explains an empty result instead of returning a bare list', () => {
    const busy: Busy[] = [{ start: '2026-06-22T00:00:00Z', end: '2026-06-23T00:00:00Z' }];
    const text = renderSlotsText(
      listOpenSlots({ from_date: '2026-06-22', to_date: '2026-06-22' }, ctx({ busy })),
    );
    expect(text).toMatch(/No open times/);
  });
});

// --- read-only invariant ---------------------------------------------------
// Policy: the MCP surface NEVER writes. This is enforced structurally, not just
// by the readOnlyHint annotation (which is advisory and clients may ignore it),
// so that adding a write to this module fails CI rather than shipping quietly.
describe('MCP is read-only by construction', () => {
  const src = readFileSync(new URL('../src/mcp.ts', import.meta.url), 'utf8');
  // Strip comments first: the module legitimately DISCUSSES POST /book in prose.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('reaches no write primitive', () => {
    for (const forbidden of [
      '.put(',            // R2 / KV write
      '.delete(',         // R2 / KV delete
      'createGraphEvent', // books on the owner's real calendar
      'graphToken',       // credentials for the above
      'sendBookingNotification',
      'sendContact',
      'verifyTurnstile',
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it('makes no outbound network call of its own', () => {
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });

  it('annotates every tool read-only', () => {
    const registrations = code.match(/server\.registerTool\(/g) ?? [];
    const annotations = code.match(/annotations: READ_ONLY/g) ?? [];
    expect(registrations.length).toBeGreaterThan(0);
    expect(annotations.length).toBe(registrations.length);
    expect(code).toContain('readOnlyHint: true');
    expect(code).toContain('destructiveHint: false');
  });

  it('imports only pure computation, never a writer', () => {
    // Multiline-aware: a single-line-only pattern silently missed a wrapped
    // `import { ... } from '...'`, which is exactly how a writer would sneak in.
    const imports = [...code.matchAll(/\bimport\b[\s\S]*?from\s*'([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual([
      './chat',
      './schedule-config',
      './scheduling',
      './slots',
      '@modelcontextprotocol/server',
      'zod',
    ]);
  });
});

// --- cross-surface consistency ---------------------------------------------
// The reason the slot rules were consolidated: POST /book re-validates a posted
// time by recomputing slots. If any surface offers a time computed on a
// different grid, the visitor gets a 409 AFTER committing. This asserts the
// offer and the booking check agree.
describe('every offered slot is bookable', () => {
  const cfg = scheduleConfig({});

  it('MCP offers only times POST /book accepts', () => {
    const busy: Busy[] = [{ start: '2026-06-23T14:00:00Z', end: '2026-06-23T15:30:00Z' }];
    const c = ctx({ busy, cfg });
    const listed = listOpenSlots(
      { from_date: '2026-06-22', to_date: '2026-06-26', max_results: 50 },
      c,
    );
    expect(listed.slots.length).toBeGreaterThan(10);
    for (const slot of listed.slots) {
      const day = isoDate(Date.parse(slot.start_utc));
      // Exactly what POST /book does with the posted time.
      const ok = slotIsBookable(
        busy,
        bookingSlotParams(cfg, day, day, NOW),
        slot.start_utc,
        slot.end_utc,
      );
      expect(ok, `offered ${slot.start_utc} but /book would reject it`).toBe(true);
    }
  });

  it('does not offer a time inside a busy block', () => {
    const busy: Busy[] = [{ start: '2026-06-22T13:00:00Z', end: '2026-06-22T14:00:00Z' }];
    const listed = listOpenSlots({ from_date: '2026-06-22', to_date: '2026-06-22' }, ctx({ busy, cfg }));
    for (const slot of listed.slots) {
      expect(Date.parse(slot.start_utc)).not.toBe(Date.parse('2026-06-22T13:00:00Z'));
    }
  });
});

// --- list_busy_blocks: the 24/7 scheduled picture --------------------------
describe('list_busy_blocks', () => {
  // Deliberately spanning night, weekend and inside-hours — the cases the
  // free-slot tool can never surface.
  const busy: Busy[] = [
    { start: '2026-06-22T06:00:00Z', end: '2026-06-22T07:00:00Z' }, // 2am EDT, overnight
    { start: '2026-06-22T13:00:00Z', end: '2026-06-22T14:00:00Z' }, // 9am EDT, in hours
    { start: '2026-06-27T18:00:00Z', end: '2026-06-27T19:00:00Z' }, // Saturday
  ];

  it('returns blocks outside working hours and on non-bookable days', () => {
    const r = listBusyBlocks({ from_date: '2026-06-22', to_date: '2026-06-28' }, ctx({ busy }));
    expect(r.blocks.map((b) => b.start_utc)).toEqual([
      '2026-06-22T06:00:00.000Z',
      '2026-06-22T13:00:00.000Z',
      '2026-06-27T18:00:00.000Z',
    ]);
    expect(r.query.hours).toBe('all');
  });

  it('surfaces exactly what list_open_slots structurally cannot', () => {
    const c = ctx({ busy });
    const slots = listOpenSlots({ from_date: '2026-06-22', to_date: '2026-06-28', max_results: 50 }, c);
    // The 2am block and the Saturday block are invisible to the bookable view...
    const slotDays = new Set(slots.slots.map((s) => s.business_weekday));
    expect(slotDays.has(6)).toBe(false); // no Saturday
    // ...but present in the scheduled view.
    const blocks = listBusyBlocks({ from_date: '2026-06-22', to_date: '2026-06-28' }, c);
    expect(blocks.blocks.some((b) => b.business_weekday === 6)).toBe(true);
    expect(blocks.blocks.some((b) => b.start_utc === '2026-06-22T06:00:00.000Z')).toBe(true);
  });

  it('includes a block that only overlaps the window edge', () => {
    const overnight: Busy[] = [{ start: '2026-06-21T23:00:00Z', end: '2026-06-22T01:00:00Z' }];
    const r = listBusyBlocks({ from_date: '2026-06-22', to_date: '2026-06-22' }, ctx({ busy: overnight }));
    expect(r.blocks).toHaveLength(1);
  });

  it('reports duration and pages with an exact cursor', () => {
    const r = listBusyBlocks({ from_date: '2026-06-22', to_date: '2026-06-28', max_results: 1 }, ctx({ busy }));
    expect(r.blocks[0].minutes).toBe(60);
    expect(r.truncated).toBe(true);
    expect(r.next_cursor).toBe('2026-06-22T06:00:00.000Z');
    const next = listBusyBlocks(
      { from_date: '2026-06-22', to_date: '2026-06-28', starting_after_utc: r.next_cursor! },
      ctx({ busy }),
    );
    expect(next.blocks[0].start_utc).toBe('2026-06-22T13:00:00.000Z');
  });

  it('rejects a calendar-invalid date', () => {
    expect(() => listBusyBlocks({ to_date: '9999-99-99' }, ctx())).toThrow(/real calendar date/);
  });

  it('says plainly that blocks carry no titles or calendar identity', () => {
    const text = renderBusyText(listBusyBlocks({ from_date: '2026-06-22', to_date: '2026-06-28' }, ctx({ busy })));
    expect(text).toMatch(/no titles/i);
    expect(text).toMatch(/which calendar/i);
    expect(text).toContain('[2026-06-22T06:00:00.000Z]');
  });

  it('leaks no label even from a labeled fixture', () => {
    const leaky = [{
      start: '2026-06-22T13:00:00Z', end: '2026-06-22T14:00:00Z',
      source: 'clientacme', status: 'busy', summary: 'Board review',
      attendees: ['ceo@acme.example'], location: 'HQ 12F', uid: 'abc-123',
    }] as unknown as Busy[];
    const r = listBusyBlocks({ from_date: '2026-06-22', to_date: '2026-06-22' }, ctx({ busy: leaky }));
    const blob = JSON.stringify(r) + renderBusyText(r);
    for (const secret of ['clientacme', 'Board review', 'ceo@acme.example', 'HQ 12F', 'abc-123']) {
      expect(blob).not.toContain(secret);
    }
    expect(Object.keys(r.blocks[0]).sort()).toEqual([
      'business_date', 'business_weekday', 'end_display', 'end_utc',
      'minutes', 'start_display', 'start_utc',
    ]);
  });
});
