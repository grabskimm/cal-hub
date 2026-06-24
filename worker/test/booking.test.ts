import { describe, expect, it } from 'vitest';

import { bookingHtml } from '../src/booking';

describe('bookingHtml', () => {
  const html = bookingHtml({
    owner: 'me@corp.com',
    title: 'Intro call',
    flavor: 'office',
    tz: 'America/New_York',
    durationMin: '30',
    slotsBase: '',
  });

  it('injects the deployment config', () => {
    expect(html).toContain('"owner":"me@corp.com"');
    expect(html).toContain('"flavor":"office"');
    expect(html).toContain('"tz":"America/New_York"');
  });

  it('consumes AvailCal /slots.json (uses the generated availability)', () => {
    expect(html).toContain("/slots.json?");
  });

  it('embeds all three provider builders bound to stable names', () => {
    expect(html).toContain('const googleCalendarUrl =');
    expect(html).toContain('const outlookComposeUrl =');
    expect(html).toContain('const icsContent =');
  });

  it('offers a universal .ics download plus Google/Outlook links', () => {
    expect(html).toContain('Download .ics');
    expect(html).toContain("'Google'");
    expect(html).toContain("'Outlook'");
    expect(html).toContain('createObjectURL');
  });
});
