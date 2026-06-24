/**
 * Pure builders for "open in an email app" links used by the booking modal, so a
 * picked slot can launch Gmail / Outlook mail / the default Mail app with a
 * prefilled booking request. Self-contained (no imports/closures) so they can be
 * unit-tested AND embedded verbatim into the page via `.toString()`.
 */

/** Gmail web compose. */
export function gmailComposeUrl(to: string, subject: string, body: string): string {
  const p = new URLSearchParams({ view: 'cm', fs: '1', to, su: subject, body });
  return 'https://mail.google.com/mail/?' + p.toString();
}

/** Outlook web *mail* compose (flavor 'live' = personal outlook.com, else M365). */
export function outlookMailUrl(to: string, subject: string, body: string, flavor: string): string {
  const base =
    flavor === 'live'
      ? 'https://outlook.live.com/mail/0/deeplink/compose'
      : 'https://outlook.office.com/mail/deeplink/compose';
  const p = new URLSearchParams({ to, subject, body });
  return base + '?' + p.toString();
}

/** Default mail app via mailto:. */
export function mailtoUrl(to: string, subject: string, body: string): string {
  const p = new URLSearchParams({ subject, body });
  return 'mailto:' + encodeURIComponent(to) + '?' + p.toString();
}
