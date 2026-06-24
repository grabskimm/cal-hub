import { describe, expect, it } from 'vitest';

import { bookingHtml } from '../src/booking';

describe('bookingHtml', () => {
  const html = bookingHtml({
    owner: 'me@corp.com',
    title: 'Intro call',
    flavor: 'office',
    tz: 'America/New_York',
    durationMin: '30',
    fallbackTz: 'America/Los_Angeles',
    slotsBase: '',
  });

  it('injects the deployment config', () => {
    expect(html).toContain('"owner":"me@corp.com"');
    expect(html).toContain('"flavor":"office"');
  });

  it('consumes AvailCal /slots.json', () => {
    expect(html).toContain('/slots.json?');
  });

  it('embeds the calendar + email launch builders', () => {
    for (const fn of [
      'const googleCalendarUrl =',
      'const outlookComposeUrl =',
      'const icsContent =',
      'const gmailComposeUrl =',
      'const outlookMailUrl =',
      'const mailtoUrl =',
    ]) {
      expect(html).toContain(fn);
    }
  });

  it('has a launch modal with email + calendar options', () => {
    expect(html).toContain('class="modal"');
    expect(html).toContain('email-row');
    expect(html).toContain('cal-row');
    expect(html).toContain("'Gmail'");
    expect(html).toContain("'Default mail app'");
    expect(html).toContain("'Google Calendar'");
    expect(html).toContain('Download .ics');
    expect(html).toContain('createObjectURL');
  });
});
