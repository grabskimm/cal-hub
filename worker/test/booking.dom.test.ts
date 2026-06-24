// @vitest-environment jsdom
//
// Runtime proof that the booking page is OPERATIONAL: render bookingHtml, execute
// its real inline <script> in a DOM, feed it a slot from a stubbed /slots.json,
// click a rendered time, and assert the launch modal opens with working Gmail /
// Outlook / .ics links. This guards against the "selecting a time does nothing"
// regression — if the click→modal wiring breaks, this test fails.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bookingHtml } from '../src/booking';

const HTML = bookingHtml({
  owner: 'mendel@mendelg.tech',
  title: 'Intro call',
  flavor: 'office',
  tz: 'America/New_York',
  durationMin: '30',
  heading: 'Book a time with Mendel',
  fallbackTz: 'America/Los_Angeles',
  slotsBase: '',
});

// A couple of free slots on the same calendar day, far enough out to be stable.
const SLOTS = [
  { start: '2026-07-15T16:00:00.000Z', end: '2026-07-15T16:30:00.000Z' },
  { start: '2026-07-15T17:00:00.000Z', end: '2026-07-15T17:30:00.000Z' },
];

/** Pull the single inline <script> body out of the rendered page. */
function extractScript(html: string): string {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no <script> found in booking page');
  return m[1];
}

/** Drop the page <body> into jsdom, run its script, wait for the calendar, then
 *  pick the available date so the times panel slides in (no date is auto-selected). */
async function bootPage(): Promise<void> {
  const body = HTML.match(/<body>([\s\S]*?)<\/body>/)![1].replace(/<script>[\s\S]*?<\/script>/, '');
  document.body.innerHTML = body;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(extractScript(HTML))();
  // Wait for fetch -> json -> picker.refresh() to render the month calendar.
  for (let i = 0; i < 50 && !document.querySelector('#cal .cal-cell.has'); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  // Nothing shows until a date is picked — click the available day.
  (document.querySelector('#cal .cal-cell.has') as HTMLButtonElement).click();
}

beforeEach(() => {
  document.body.innerHTML = '';
  // jsdom has no fetch / object URLs — stub both.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ slots: SLOTS }) })),
  );
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:ics', revokeObjectURL: () => {} }));
});

describe('booking page (DOM runtime)', () => {
  it('renders selectable time chips from /slots.json', async () => {
    await bootPage();
    const chips = document.querySelectorAll('#times .chip');
    expect(chips.length).toBe(SLOTS.length);
    expect((chips[0] as HTMLElement).textContent).toMatch(/\d{1,2}:\d{2}/);
  });

  it('opens the launch modal when a time is clicked', async () => {
    await bootPage();
    const modal = document.getElementById('modal') as HTMLElement;
    expect(modal.hidden).toBe(true); // closed until a time is picked

    (document.querySelector('#times .chip') as HTMLButtonElement).click();

    expect(modal.hidden).toBe(false); // the booking flow launched
    expect(document.getElementById('mwhen')!.textContent).toMatch(/July 15 ·.*4:00/);
  });

  it('populates the modal with working email + calendar launch links', async () => {
    await bootPage();
    (document.querySelector('#times .chip') as HTMLButtonElement).click();

    const emailLinks = [...document.querySelectorAll('#email-row a')] as HTMLAnchorElement[];
    const calLinks = [...document.querySelectorAll('#cal-row a')] as HTMLAnchorElement[];

    // Gmail / Outlook / default mail-app compose links.
    expect(emailLinks.some((a) => a.href.includes('mail.google.com'))).toBe(true);
    expect(emailLinks.some((a) => a.href.startsWith('mailto:'))).toBe(true);
    // Google + Outlook calendar links and a downloadable .ics.
    expect(calLinks.some((a) => a.href.includes('calendar.google.com'))).toBe(true);
    expect(calLinks.some((a) => a.hasAttribute('download'))).toBe(true);
  });

  it('closes the modal with the × button', async () => {
    await bootPage();
    (document.querySelector('#times .chip') as HTMLButtonElement).click();
    expect((document.getElementById('modal') as HTMLElement).hidden).toBe(false);

    (document.getElementById('x') as HTMLButtonElement).click();
    expect((document.getElementById('modal') as HTMLElement).hidden).toBe(true);
  });
});
