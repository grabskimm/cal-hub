import { describe, expect, it } from 'vitest';

import { googleCalendarUrl, icsContent, outlookComposeUrl } from '../src/calendar-links';

const slot = { start: '2026-06-24T13:00:00.000Z', end: '2026-06-24T13:30:00.000Z' };

describe('googleCalendarUrl', () => {
  it('builds a render template with compact UTC dates + guest', () => {
    const url = googleCalendarUrl(slot, { owner: 'me@x.com', title: 'Intro call' });
    expect(url.startsWith('https://calendar.google.com/calendar/render?')).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get('action')).toBe('TEMPLATE');
    expect(q.get('text')).toBe('Intro call');
    expect(q.get('dates')).toBe('20260624T130000Z/20260624T133000Z');
    expect(q.get('add')).toBe('me@x.com');
  });
  it('omits the guest when owner is empty', () => {
    expect(new URL(googleCalendarUrl(slot, { owner: '', title: 'X' })).searchParams.has('add')).toBe(false);
  });
});

describe('outlookComposeUrl', () => {
  it('office (M365) deeplink with slot + invitee + encoded subject', () => {
    const url = outlookComposeUrl(slot, { owner: 'me@corp.com', title: 'Q3 review & sync' }, 'office');
    expect(url.startsWith('https://outlook.office.com/calendar/0/deeplink/compose?')).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get('startdt')).toBe(slot.start);
    expect(q.get('enddt')).toBe(slot.end);
    expect(q.get('subject')).toBe('Q3 review & sync');
    expect(q.get('to')).toBe('me@corp.com');
    expect(url).toContain('subject=Q3+review+%26+sync');
  });
  it('personal (live) flavor uses outlook.com', () => {
    const url = outlookComposeUrl(slot, { owner: '', title: 'X' }, 'live');
    expect(url.startsWith('https://outlook.live.com/calendar/0/deeplink/compose?')).toBe(true);
  });
});

describe('icsContent', () => {
  const ics = icsContent(slot, { owner: 'me@x.com', title: 'Intro; call' });
  it('is a valid VCALENDAR with compact UTC times and CRLF', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('\r\nDTSTART:20260624T130000Z\r\n');
    expect(ics).toContain('\r\nDTEND:20260624T133000Z\r\n');
    expect(ics.trim().endsWith('END:VCALENDAR')).toBe(true);
  });
  it('escapes special chars in SUMMARY and includes organizer/attendee', () => {
    expect(ics).toContain('SUMMARY:Intro\\; call');
    expect(ics).toContain('ORGANIZER:mailto:me@x.com');
    expect(ics).toContain('ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:me@x.com');
  });
  it('omits organizer/attendee when owner is empty', () => {
    const anon = icsContent(slot, { owner: '', title: 'X' });
    expect(anon).not.toContain('ORGANIZER');
    expect(anon).not.toContain('ATTENDEE');
  });
});
