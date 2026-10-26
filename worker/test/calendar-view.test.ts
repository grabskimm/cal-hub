import { describe, expect, it } from 'vitest';

import { calendarHtml, labelColor, tzParts } from '../src/calendar-view';

describe('tzParts', () => {
  it('gives local day + minutes-from-midnight (summer EDT)', () => {
    // 13:30Z on 2026-06-24 == 09:30 in New York (EDT, -4)
    const p = tzParts('2026-06-24T13:30:00Z', 'America/New_York');
    expect(p.dayKey).toBe('2026-06-24');
    expect(p.minutes).toBe(9 * 60 + 30);
  });
  it('rolls to the previous local day across midnight (LA)', () => {
    // 03:00Z == 20:00 previous day in Los Angeles (PDT, -7)
    const p = tzParts('2026-06-24T03:00:00Z', 'America/Los_Angeles');
    expect(p.dayKey).toBe('2026-06-23');
    expect(p.minutes).toBe(20 * 60);
  });
});

describe('labelColor', () => {
  it('is deterministic and label-dependent', () => {
    expect(labelColor('MendelG')).toBe(labelColor('MendelG'));
    expect(labelColor('MendelG')).not.toBe(labelColor('LoganG'));
    expect(labelColor('X')).toMatch(/^hsl\(\d+, 62%, 45%\)$/);
  });
});

describe('calendarHtml', () => {
  const html = calendarHtml({ title: 'My calendar', fallbackTz: 'America/Los_Angeles' });
  it('is token-gated client-side and reads the labeled busy feed', () => {
    expect(html).toContain("/busy.json?token=");
    expect(html).toContain("get('token')");
  });
  it('embeds the pure helpers bound to stable names', () => {
    expect(html).toContain('function tzParts');
    expect(html).toContain('function labelColor');
  });

  it('links booking + contact to the PUBLIC host absolutely (never a private /book)', () => {
    const withLinks = calendarHtml({
      title: 'My calendar',
      fallbackTz: 'America/Los_Angeles',
      bookHref: 'https://availability.example.com/book',
      contactHref: 'https://availability.example.com/contact',
    });
    expect(withLinks).toContain('href="https://availability.example.com/book"');
    expect(withLinks).toContain('href="https://availability.example.com/contact"');
    // The old relative link that 404s on the private host must be gone.
    expect(withLinks).not.toContain('href="/book"');
  });

  it('omits the nav links when no public host is configured', () => {
    expect(html).not.toContain('href="/book"');
    expect(html).not.toContain('✉ Contact');
    expect(html).not.toContain('⌂ Home');
  });

  it('adds a Home link to the public host when configured', () => {
    const withHome = calendarHtml({
      title: 'My calendar',
      fallbackTz: 'America/Los_Angeles',
      homeHref: 'https://availability.example.com',
    });
    expect(withHome).toContain('href="https://availability.example.com">⌂ Home');
  });

  it('offers day/week/month views and defaults to week', () => {
    expect(html).toContain('data-v="day"');
    expect(html).toContain('data-v="week"');
    expect(html).toContain('data-v="month"');
    // Week is the active (default) view button.
    expect(html).toMatch(/data-v="week" class="active"/);
    expect(html).toContain("let view = 'week'");
  });

  it('draws a current-time line in the viewer timezone', () => {
    expect(html).toContain('nowline');
    expect(html).toContain('nowMinutes');
  });

  it('lets you drag an hour range (Day view) and open it in Outlook', () => {
    expect(html).toContain('function outlookComposeUrl'); // deep-link builder embedded
    expect(html).toContain('function enableDaySelect');
    expect(html).toContain('function zonedToUtc'); // wall-clock -> UTC for the deeplink
    expect(html).toContain('id="selpop"'); // title prompt popup
    expect(html).toContain('Open in Outlook');
    expect(html).toContain("'office'"); // Office 365 flavor
    // Mobile: tap-start, then tap or hold-drag to end (a swipe still scrolls).
    expect(html).toContain('touchstart');
    expect(html).toContain('touchmove');
    expect(html).toContain('touchend');
    expect(html).toContain('seltap');
    // Mobile launches the Outlook app (ms-outlook://) with a browser fallback.
    expect(html).toContain('ms-outlook://events/new');
    expect(html).toContain('IS_MOBILE');
    expect(html).toContain('id="selpop-web"');
  });

  it('uses a compact timezone dropdown', () => {
    expect(html).toContain('<select id="tz">');
    expect(html).toContain('class="field tzfield"');
    expect(html).not.toContain('list="tz-list"');
  });

  it('omits the "Refresh now" button unless the viewer is Access-authorized', () => {
    // A ?token= viewer holds FEED_TOKEN, a READ credential. Rendering the
    // button for them would promise an action the POST then 401s on.
    expect(html).not.toContain('id="runsync"');
    expect(html).not.toContain("fetch('/run'");
  });

  it('wires "Refresh now" to a same-origin POST /run carrying the CSRF header', () => {
    const withRun = calendarHtml({
      title: "Mendel's calendar", fallbackTz: 'UTC', canRun: true,
    });
    expect(withRun).toContain('id="runsync"');
    expect(withRun).toContain('Refresh now');
    expect(withRun).toContain("fetch('/run'");
    expect(withRun).toContain("method: 'POST'");
    // The custom header is the CSRF defence: it makes the request non-simple,
    // so a cross-origin forgery must preflight and gets refused.
    expect(withRun).toContain("'X-AvailCal-Run': '1'");
    // Relative URL => same-origin => the CF_Authorization cookie rides along,
    // and no token is ever put in the page.
    expect(withRun).not.toContain('/run?token=');
    // The UI must survive a slow or dead run rather than spinning forever.
    expect(withRun).toContain('AbortController');
    expect(withRun).toContain('AbortError');
    // And it reports the documented rejections rather than a bare status code.
    expect(withRun).toContain('429');
    expect(withRun).toContain('sign-in expired');
  });

  it('has a dismissible new-events notifications area backed by /notifications.json', () => {
    expect(html).toContain('id="notify"');
    expect(html).toContain('/notifications.json?token=');
    expect(html).toContain('Dismiss all');
    // Dismissals persist client-side.
    expect(html).toContain('localStorage');
    expect(html).toContain('availcal_dismissed_notifications');
  });
});
