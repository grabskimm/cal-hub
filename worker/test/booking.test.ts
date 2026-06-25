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

  it('uses a compact timezone dropdown (styled, not stretched)', () => {
    expect(html).toContain('<select id="tz">');
    expect(html).toContain('class="field tzfield"');
    expect(html).not.toContain('list="tz-list"');
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

  it('omits the "book it for me" section unless scheduling is enabled', () => {
    expect(html).not.toContain('id="req"');
    expect(html).not.toContain('data-sitekey');
    expect(html).not.toContain('Send booking request');
  });
});

describe('bookingHtml with scheduling enabled', () => {
  const html = bookingHtml({
    owner: 'me@corp.com', title: 'Intro call', flavor: 'office',
    tz: 'America/New_York', durationMin: '30', heading: 'Book with Mendel',
    fallbackTz: 'America/Los_Angeles', slotsBase: '',
    scheduling: { enabled: true, zoom: true, turnstileSiteKey: '0xSITEKEY' },
  });

  it('renders the request form, meeting choices, and Turnstile widget', () => {
    expect(html).toContain('id="req"');
    expect(html).toContain('id="r-email"');
    expect(html).toContain("value=\"teams\"");
    expect(html).toContain("value=\"zoom\"");
    expect(html).toContain('data-sitekey="0xSITEKEY"');
    expect(html).toContain('challenges.cloudflare.com/turnstile');
    expect(html).toContain("'/book'");
  });

  it('includes the post-booking confirmation screen', () => {
    expect(html).toContain('id="confirmed"');
    expect(html).toContain('id="c-email"');
    expect(html).toContain('id="c-done"');
    expect(html).toContain("You're booked!");
  });

  it('hides the Zoom choice when no Zoom link is configured', () => {
    const noZoom = bookingHtml({
      owner: '', title: 'x', flavor: 'office', tz: 'UTC', durationMin: '30',
      heading: 'h', slotsBase: '', scheduling: { enabled: true, zoom: false, turnstileSiteKey: '' },
    });
    expect(noZoom).toContain('id="req"');
    expect(noZoom).toContain('value="teams"');
    expect(noZoom).not.toContain('value="zoom"');
    expect(noZoom).not.toContain('data-sitekey'); // no widget without a site key
  });
});
