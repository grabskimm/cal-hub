import { describe, it, expect } from 'vitest';
import {
  validateBooking,
  buildGraphEvent,
  slotIsBookable,
  schedulingEnabled,
  zoomEnabled,
  type BookingRequest,
} from '../src/scheduling';
import type { Busy } from '../src/slots';

const NOW = Date.parse('2026-07-01T12:00:00Z');
const future = (h: number) => new Date(NOW + h * 3600_000).toISOString();

describe('schedulingEnabled / zoomEnabled', () => {
  it('needs all four MS settings', () => {
    expect(schedulingEnabled({})).toBe(false);
    expect(schedulingEnabled({ MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's' })).toBe(false);
    expect(schedulingEnabled({ MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MS_MAILBOX: 'm@x' })).toBe(true);
  });
  it('zoom needs a link', () => {
    expect(zoomEnabled({})).toBe(false);
    expect(zoomEnabled({ ZOOM_PERSONAL_LINK: 'https://zoom.us/j/1' })).toBe(true);
  });
});

describe('validateBooking', () => {
  const opts = { defaultSubject: 'Meeting', zoomAvailable: true, nowMs: NOW };

  it('accepts a well-formed request', () => {
    const r = validateBooking({ start: future(2), end: future(2.5), email: 'a@b.com', name: 'A', meeting: 'teams' }, opts);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.booking.email).toBe('a@b.com'); expect(r.booking.meeting).toBe('teams'); expect(r.booking.subject).toBe('Meeting'); }
  });
  it('rejects a bad email', () => {
    expect(validateBooking({ start: future(2), end: future(2.5), email: 'nope' }, opts)).toEqual({ ok: false, error: 'Please enter a valid email.' });
  });
  it('rejects past times', () => {
    expect(validateBooking({ start: future(-2), end: future(-1.5), email: 'a@b.com' }, opts)).toEqual({ ok: false, error: 'That time is in the past.' });
  });
  it('rejects end <= start', () => {
    expect(validateBooking({ start: future(2), end: future(2), email: 'a@b.com' }, opts)).toEqual({ ok: false, error: 'End must be after start.' });
  });
  it('downgrades zoom to none when zoom is unavailable', () => {
    const r = validateBooking({ start: future(2), end: future(2.5), email: 'a@b.com', meeting: 'zoom' }, { ...opts, zoomAvailable: false });
    expect(r.ok && r.booking.meeting).toBe('none');
  });
  it('normalises an unknown meeting type to none', () => {
    const r = validateBooking({ start: future(2), end: future(2.5), email: 'a@b.com', meeting: 'skype' }, opts);
    expect(r.ok && r.booking.meeting).toBe('none');
  });
});

describe('buildGraphEvent', () => {
  const base: BookingRequest = { start: future(2), end: future(2.5), email: 'a@b.com', name: 'Ann', subject: 'Chat', meeting: 'none' };
  it('adds attendee + UTC times', () => {
    const ev = buildGraphEvent(base, {}) as any;
    expect(ev.subject).toBe('Chat');
    expect(ev.attendees[0].emailAddress.address).toBe('a@b.com');
    expect(ev.start.timeZone).toBe('UTC');
    expect(ev.isOnlineMeeting).toBeUndefined();
  });
  it('teams sets isOnlineMeeting', () => {
    const ev = buildGraphEvent({ ...base, meeting: 'teams' }, {}) as any;
    expect(ev.isOnlineMeeting).toBe(true);
    expect(ev.onlineMeetingProvider).toBe('teamsForBusiness');
  });
  it('zoom embeds the configured link, no Teams flag', () => {
    const ev = buildGraphEvent({ ...base, meeting: 'zoom' }, { zoomLink: 'https://zoom.us/j/9' }) as any;
    expect(ev.isOnlineMeeting).toBeUndefined();
    expect(ev.location.displayName).toBe('Zoom');
    expect(ev.body.content).toContain('https://zoom.us/j/9');
  });
  it('phone sets a Phone location with owner + attendee numbers', () => {
    const ev = buildGraphEvent({ ...base, meeting: 'phone', phone: '+1 555 9999' }, { ownerPhone: '+1 555 0000' }) as any;
    expect(ev.isOnlineMeeting).toBeUndefined();
    expect(ev.location.displayName).toBe('Phone call');
    expect(ev.body.content).toContain('+1 555 0000');
    expect(ev.body.content).toContain('+1 555 9999');
  });
});

describe('validateBooking phone', () => {
  const opts = { defaultSubject: 'Meeting', zoomAvailable: false, phoneAvailable: true, nowMs: NOW };
  it('keeps phone + number when available', () => {
    const r = validateBooking({ start: future(2), end: future(2.5), email: 'a@b.com', meeting: 'phone', phone: '+1 555 1234' }, opts);
    expect(r.ok && r.booking.meeting).toBe('phone');
    expect(r.ok && r.booking.phone).toBe('+1 555 1234');
  });
  it('downgrades phone to none when unavailable', () => {
    const r = validateBooking({ start: future(2), end: future(2.5), email: 'a@b.com', meeting: 'phone' }, { ...opts, phoneAvailable: false });
    expect(r.ok && r.booking.meeting).toBe('none');
  });
});

describe('slotIsBookable', () => {
  // free all day; 30-min slots, Mon-Fri 09:00-17:00 UTC. 2026-07-01 is a Wednesday.
  const params = {
    fromDate: '2026-07-01', toDate: '2026-07-01', tz: 'UTC',
    durationMin: 30, stepMin: 30, workStart: '09:00', workEnd: '17:00',
    days: [1, 2, 3, 4, 5], nowMs: NOW, maxSlots: 2000,
  };
  const busy: Busy[] = [];

  it('accepts an exact offered slot', () => {
    expect(slotIsBookable(busy, params, '2026-07-01T13:00:00.000Z', '2026-07-01T13:30:00.000Z')).toBe(true);
  });
  it('rejects an off-grid start', () => {
    expect(slotIsBookable(busy, params, '2026-07-01T13:07:00.000Z', '2026-07-01T13:37:00.000Z')).toBe(false);
  });
  it('rejects a slot that collides with busy', () => {
    const busy2: Busy[] = [{ start: '2026-07-01T13:00:00.000Z', end: '2026-07-01T13:30:00.000Z' }];
    expect(slotIsBookable(busy2, params, '2026-07-01T13:00:00.000Z', '2026-07-01T13:30:00.000Z')).toBe(false);
  });
});
