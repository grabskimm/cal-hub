import { describe, expect, it } from 'vitest';

import { bookingHtml } from '../src/booking';

describe('bookingHtml', () => {
  const html = bookingHtml({
    owner: 'me@corp.com',
    title: 'Intro call',
    flavor: 'office',
    tz: 'America/New_York',
    durationMin: '30',
    heading: 'Book a time with Mendel',
    fallbackTz: 'America/Los_Angeles',
    slotsBase: '',
  });

  it('injects the deployment config + personalised heading', () => {
    expect(html).toContain('"owner":"me@corp.com"');
    expect(html).toContain('"flavor":"office"');
    expect(html).toContain('Book a time with Mendel');
  });

  it('consumes AvailCal /slots.json', () => {
    expect(html).toContain('/slots.json?');
  });

  it('uses a compact searchable timezone input (not a wide select)', () => {
    expect(html).toContain('id="tz" list="tz-list"');
    expect(html).toContain('<datalist id="tz-list">');
    expect(html).toContain('class="field tzfield"');
    expect(html).not.toContain('<select id="tz">');
  });

  it('embeds the calendar + email launch builders', () => {
    for (const fn of ['const googleCalendarUrl =', 'const outlookComposeUrl =', 'const icsContent =']) {
      expect(html).toContain(fn);
    }
  });

  it('has a launch modal with calendar options only (no email request)', () => {
    expect(html).toContain('class="modal"');
    expect(html).toContain('cal-row');
    expect(html).toContain("'Google Calendar'");
    expect(html).toContain("'Outlook Calendar'");
    expect(html).toContain('Download .ics');
    expect(html).toContain('createObjectURL');
    // Email-request path is gone.
    expect(html).not.toContain('email-row');
    expect(html).not.toContain("'Gmail'");
    expect(html).not.toContain('const mailtoUrl =');
  });
});
