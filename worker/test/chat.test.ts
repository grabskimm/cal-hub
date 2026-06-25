import { describe, it, expect } from 'vitest';
import {
  parseAction,
  rankSlots,
  localHour,
  systemPrompt,
  formatProposedReply,
  chatEnabled,
} from '../src/chat';
import type { Slot } from '../src/slots';

describe('chatEnabled', () => {
  it('needs the AI binding', () => {
    expect(chatEnabled({})).toBe(false);
    expect(chatEnabled({ AI: {} })).toBe(true);
  });
});

describe('parseAction', () => {
  it('parses a propose action with preferences', () => {
    const a = parseAction('sure! {"kind":"propose","partOfDay":"afternoon","days":[2,3],"durationMin":30,"reply":"On it"} ');
    expect(a.kind).toBe('propose');
    expect(a.partOfDay).toBe('afternoon');
    expect(a.days).toEqual([2, 3]);
    expect(a.reply).toBe('On it');
  });
  it('parses a book action', () => {
    const a = parseAction('{"kind":"book","pickIndex":2,"email":"a@b.com","meeting":"teams","reply":"Booking it"}');
    expect(a.kind).toBe('book');
    expect(a.pickIndex).toBe(2);
    expect(a.email).toBe('a@b.com');
    expect(a.meeting).toBe('teams');
  });
  it('defaults to reply on junk / bad json', () => {
    expect(parseAction('hello there').kind).toBe('reply');
    expect(parseAction('{not json').kind).toBe('reply');
  });
  it('tolerates non-string model output (object / null) without throwing', () => {
    // The AI binding sometimes hands back an object instead of a string.
    expect(parseAction({ kind: 'propose', partOfDay: 'morning', reply: 'hi' } as unknown).kind).toBe('propose');
    expect(parseAction(null as unknown).kind).toBe('reply');
    expect(parseAction(undefined as unknown).kind).toBe('reply');
  });
  it('drops invalid enum / day values', () => {
    const a = parseAction('{"kind":"propose","partOfDay":"midnight","days":[9,1],"meeting":"skype"}');
    expect(a.partOfDay).toBeUndefined();
    expect(a.days).toEqual([1]);
    expect(a.meeting).toBeUndefined();
  });
});

describe('localHour', () => {
  it('reads the hour in the target tz', () => {
    expect(localHour('2026-07-15T16:00:00.000Z', 'UTC')).toBe(16);
    expect(localHour('2026-07-15T16:00:00.000Z', 'America/New_York')).toBe(12); // EDT -4
  });
});

describe('rankSlots', () => {
  const tz = 'UTC';
  const slots: Slot[] = [
    { start: '2026-07-14T09:00:00.000Z', end: '2026-07-14T09:30:00.000Z' }, // Tue morning
    { start: '2026-07-14T14:00:00.000Z', end: '2026-07-14T14:30:00.000Z' }, // Tue afternoon
    { start: '2026-07-15T15:00:00.000Z', end: '2026-07-15T15:30:00.000Z' }, // Wed afternoon
    { start: '2026-07-15T19:00:00.000Z', end: '2026-07-15T19:30:00.000Z' }, // Wed evening
  ];
  it('filters by part of day', () => {
    const r = rankSlots(slots, { partOfDay: 'afternoon' }, tz);
    expect(r.map((s) => s.start)).toEqual([
      '2026-07-14T14:00:00.000Z', '2026-07-15T15:00:00.000Z',
    ]);
  });
  it('filters by weekday (Wed=3)', () => {
    const r = rankSlots(slots, { days: [3] }, tz);
    expect(r.every((s) => new Date(s.start).getUTCDay() === 3)).toBe(true);
    expect(r.length).toBe(2);
  });
  it('caps to max', () => {
    expect(rankSlots(slots, {}, tz, 2).length).toBe(2);
  });
  it('excludes already-shown slots so "more times" returns fresh ones', () => {
    const exclude = new Set(['2026-07-14T09:00:00.000Z', '2026-07-14T14:00:00.000Z']);
    const r = rankSlots(slots, { exclude }, tz, 3);
    expect(r.map((s) => s.start)).toEqual([
      '2026-07-15T15:00:00.000Z', '2026-07-15T19:00:00.000Z',
    ]);
  });
});

describe('formatProposedReply', () => {
  it('lists the real times the Worker computed', () => {
    const out = formatProposedReply('Here you go:', [
      { start: '2026-07-14T14:00:00.000Z', end: '2026-07-14T14:30:00.000Z' },
    ], 'UTC');
    expect(out).toContain('1.');
    expect(out).toContain('Reply with the number');
  });
  it('handles no matches gracefully', () => {
    expect(formatProposedReply('', [], 'UTC')).toContain("couldn't find");
  });
});

describe('systemPrompt', () => {
  it('includes today, the meeting options, and any proposed slots', () => {
    const p = systemPrompt({
      todayIso: '2026-07-13', ownerName: 'Mendel', tz: 'UTC', durationMin: 30,
      meetings: ['teams', 'phone'],
      proposed: [{ start: '2026-07-14T14:00:00.000Z', end: '2026-07-14T14:30:00.000Z' }],
    });
    expect(p).toContain('Mendel');
    expect(p).toContain('teams, phone');
    expect(p).toContain('pickIndex');
    expect(p).toContain('1.');
  });

  it('schedule mode stays scheduling-only and omits the bio', () => {
    const p = systemPrompt({
      todayIso: '2026-07-13', ownerName: 'Mendel', tz: 'UTC', durationMin: 30,
      meetings: ['teams'], mode: 'schedule', bio: 'Secret bio facts',
    });
    expect(p).toContain('scheduling assistant');
    expect(p).not.toContain('Secret bio facts');
    expect(p).not.toContain('ABOUT');
  });

  it('assistant mode adds the persona + ABOUT bio', () => {
    const p = systemPrompt({
      todayIso: '2026-07-13', ownerName: 'Mendel', tz: 'UTC', durationMin: 30,
      meetings: ['teams'], mode: 'assistant', bio: 'Mendel builds things.',
    });
    expect(p).toContain('personal assistant');
    expect(p).toContain('ABOUT Mendel:');
    expect(p).toContain('Mendel builds things.');
    expect(p).toContain('never invent biographical details');
  });

  it('assistant mode without a bio falls back gracefully', () => {
    const p = systemPrompt({
      todayIso: '2026-07-13', ownerName: 'Mendel', tz: 'UTC', durationMin: 30,
      meetings: ['teams'], mode: 'assistant',
    });
    expect(p).toContain('personal assistant');
    expect(p).toContain('no detailed bio');
  });
});
