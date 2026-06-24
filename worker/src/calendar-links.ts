/**
 * Provider-agnostic "add to calendar" builders for the booking page. The
 * booker's platform is unknown, so a selected AvailCal free slot becomes a
 * universal `.ics` (Apple Calendar / Outlook desktop / anything) plus quick
 * links for Google and Outlook web. All read-only — no write credential.
 *
 * Each function is fully self-contained (no shared helpers, no closure refs) so
 * it can be unit-tested here AND embedded verbatim into the booking page via
 * `.toString()` — one source of truth, safe under bundler minification.
 */

export interface CalSlot {
  start: string; // UTC ISO
  end: string; // UTC ISO
}

export interface CalCfg {
  owner: string; // owner email -> invitee/guest; '' to omit
  title: string;
}

/** Google Calendar "render" template URL (adds the owner as a guest). */
export function googleCalendarUrl(slot: CalSlot, cfg: CalCfg): string {
  const compact = (iso: string) =>
    new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: cfg.title,
    dates: compact(slot.start) + '/' + compact(slot.end),
  });
  if (cfg.owner) p.set('add', cfg.owner);
  return 'https://calendar.google.com/calendar/render?' + p.toString();
}

/** Outlook web compose deeplink. flavor: 'live' = personal, else M365. */
export function outlookComposeUrl(slot: CalSlot, cfg: CalCfg, flavor: string): string {
  const base =
    flavor === 'live'
      ? 'https://outlook.live.com/calendar/0/deeplink/compose'
      : 'https://outlook.office.com/calendar/0/deeplink/compose';
  const p = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    startdt: slot.start,
    enddt: slot.end,
    subject: cfg.title,
  });
  if (cfg.owner) p.set('to', cfg.owner);
  return base + '?' + p.toString();
}

/** A complete VCALENDAR string for a universal .ics download (CRLF line ends). */
export function icsContent(slot: CalSlot, cfg: CalCfg): string {
  const compact = (iso: string) =>
    new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s: string) => s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const uid = compact(slot.start) + '-' + compact(slot.end) + '@availcal-booking';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//availcal//booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:' + uid,
    'DTSTAMP:' + compact(slot.start),
    'DTSTART:' + compact(slot.start),
    'DTEND:' + compact(slot.end),
    'SUMMARY:' + esc(cfg.title),
  ];
  if (cfg.owner) {
    lines.push('ORGANIZER:mailto:' + cfg.owner);
    lines.push('ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:' + cfg.owner);
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}
