/**
 * Booking → Outlook: create the requested meeting on the OWNER's Microsoft 365
 * calendar (app-only Microsoft Graph) and let Outlook email the invite. This is
 * the "have me put it on the calendar" path on /book; the existing "add to your
 * own calendar" links are unchanged and remain the default. The whole feature is
 * gated by config — when the Graph secrets are absent it is disabled and /book
 * just serves the calendar links, so it is safe to ship before setup is done.
 *
 * Auth is app-only client-credentials against a single fixed mailbox (the owner
 * controls it), so there is no per-user OAuth, no refresh token, and nothing
 * that expires. Scope the Entra app to that one mailbox with an Exchange
 * Application Access Policy.
 */
import { type Busy, type SlotParams, computeSlots } from './slots';

export interface SchedulingEnv {
  MS_TENANT_ID?: string;
  MS_CLIENT_ID?: string;
  MS_CLIENT_SECRET?: string;
  MS_MAILBOX?: string; // the mailbox to write to (UPN / primary SMTP address)
  TURNSTILE_SECRET?: string; // Cloudflare Turnstile secret (bot protection)
  ZOOM_PERSONAL_LINK?: string; // optional static Zoom URL for the "Zoom" option
  BOOKING_TITLE?: string; // default event subject
  // Owner notification on each booking (reuses the Resend/contact settings).
  CONTACT_API_KEY?: string;
  CONTACT_FROM?: string;
  CONTACT_PROVIDER?: string; // 'resend' (default) | 'sendgrid'
  CONTACT_TO?: string;
  BOOKING_OWNER_EMAIL?: string;
  BOOKING_NOTIFY_TO?: string; // explicit recipient; falls back to CONTACT_TO / owner
}

export interface NotifyConfig { apiKey: string; from: string; to: string; provider: string; }

/** Where to email the owner when a booking is created, or null if not configured. */
export function bookingNotifyConfig(env: SchedulingEnv): NotifyConfig | null {
  const apiKey = (env.CONTACT_API_KEY ?? '').trim();
  const from = (env.CONTACT_FROM ?? '').trim();
  const to = (env.BOOKING_NOTIFY_TO ?? env.CONTACT_TO ?? env.BOOKING_OWNER_EMAIL ?? '').trim();
  if (!apiKey || !from || !to) return null;
  return { apiKey, from, to, provider: (env.CONTACT_PROVIDER ?? 'resend').trim().toLowerCase() };
}

/** Best-effort "you have a new booking" email to the owner (via Resend/SendGrid). */
export async function sendBookingNotification(cfg: NotifyConfig, booking: BookingRequest, whenText: string): Promise<void> {
  const mtg = booking.meeting === 'teams' ? ' · Teams'
    : booking.meeting === 'zoom' ? ' · Zoom'
    : booking.meeting === 'phone' ? ` · Phone${booking.phone ? ' ' + booking.phone : ''}` : '';
  const who = booking.name ? `${booking.name} <${booking.email}>` : booking.email;
  const subject = `New booking: ${booking.subject} — ${whenText}`;
  const text = `A new event was created on your calendar.\n\nWhen: ${whenText}${mtg}\nWith: ${who}\nSubject: ${booking.subject}`;
  try {
    if (cfg.provider === 'sendgrid') {
      await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: cfg.to }] }],
          from: { email: cfg.from }, reply_to: { email: booking.email },
          subject, content: [{ type: 'text/plain', value: text }],
        }),
      });
      return;
    }
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: cfg.from, to: [cfg.to], subject, text, reply_to: booking.email }),
    });
  } catch (e) {
    console.warn(`booking notify failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** True when the Graph write path is fully configured. */
export function schedulingEnabled(env: SchedulingEnv): boolean {
  return Boolean(
    env.MS_TENANT_ID?.trim() && env.MS_CLIENT_ID?.trim() &&
    env.MS_CLIENT_SECRET?.trim() && env.MS_MAILBOX?.trim(),
  );
}
export function turnstileEnabled(env: SchedulingEnv): boolean {
  return Boolean(env.TURNSTILE_SECRET?.trim());
}
export function zoomEnabled(env: SchedulingEnv): boolean {
  return Boolean(env.ZOOM_PERSONAL_LINK?.trim());
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface BookingRequest {
  start: string; // UTC ISO
  end: string; // UTC ISO
  email: string;
  name: string;
  subject: string;
  meeting: 'none' | 'teams' | 'zoom' | 'phone';
  phone?: string; // the attendee's number, only for a phone meeting (optional)
}

/** Validate + normalise an incoming booking request (pure). */
export function validateBooking(
  payload: Record<string, unknown>,
  opts: { defaultSubject: string; zoomAvailable: boolean; phoneAvailable?: boolean; nowMs: number },
): { ok: true; booking: BookingRequest } | { ok: false; error: string } {
  const start = String(payload.start ?? '').trim();
  const end = String(payload.end ?? '').trim();
  const email = String(payload.email ?? '').trim().slice(0, 200);
  const name = String(payload.name ?? '').trim().slice(0, 120);
  const subject = (String(payload.subject ?? '').trim().slice(0, 200)) || opts.defaultSubject;
  const phone = String(payload.phone ?? '').trim().slice(0, 40);
  let meeting = String(payload.meeting ?? 'none').trim().toLowerCase();

  const sMs = Date.parse(start);
  const eMs = Date.parse(end);
  if (!Number.isFinite(sMs) || !Number.isFinite(eMs)) return { ok: false, error: 'Invalid time.' };
  if (eMs <= sMs) return { ok: false, error: 'End must be after start.' };
  if (sMs < opts.nowMs - 60_000) return { ok: false, error: 'That time is in the past.' };
  if (eMs - sMs > 24 * 3600_000) return { ok: false, error: 'Meeting too long.' };
  if (!email || !EMAIL_RE.test(email)) return { ok: false, error: 'Please enter a valid email.' };
  if (meeting !== 'teams' && meeting !== 'zoom' && meeting !== 'phone') meeting = 'none';
  if (meeting === 'zoom' && !opts.zoomAvailable) meeting = 'none';
  if (meeting === 'phone' && !opts.phoneAvailable) meeting = 'none';

  return {
    ok: true,
    booking: { start, end, email, name, subject, meeting: meeting as BookingRequest['meeting'], phone },
  };
}

/**
 * Server-side double-book / tamper guard: recompute the owner's free slots and
 * confirm the requested window is genuinely an offered slot. Never trust the
 * client — they could POST any time. Uses the SAME slot rules as /slots.json.
 */
export function slotIsBookable(busy: Busy[], params: SlotParams, startIso: string, endIso: string): boolean {
  const sMs = Date.parse(startIso);
  const eMs = Date.parse(endIso);
  if (!Number.isFinite(sMs) || !Number.isFinite(eMs)) return false;
  return computeSlots(busy, params).some((s) => Date.parse(s.start) === sMs && Date.parse(s.end) === eMs);
}

/** Verify a Cloudflare Turnstile token. */
export async function verifyTurnstile(secret: string, token: string, ip: string | null): Promise<boolean> {
  if (!token) return false;
  try {
    const form = new URLSearchParams({ secret, response: token });
    if (ip) form.set('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const data = (await res.json().catch(() => ({}))) as { success?: boolean };
    return Boolean(data.success);
  } catch {
    return false;
  }
}

/** Mint an app-only Graph access token via the client-credentials grant. */
export async function graphToken(env: SchedulingEnv): Promise<string | null> {
  try {
    const body = new URLSearchParams({
      client_id: env.MS_CLIENT_ID ?? '',
      client_secret: env.MS_CLIENT_SECRET ?? '',
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });
    const res = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(env.MS_TENANT_ID ?? '')}/oauth2/v2.0/token`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() },
    );
    if (!res.ok) {
      const detail = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
      console.warn(`graph token ${res.status}: ${detail.slice(0, 300)}`);
      return null;
    }
    const data = (await res.json()) as { access_token?: string };
    return data.access_token ?? null;
  } catch (e) {
    console.warn(`graph token threw: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** Build the Graph event body (pure). Graph emails the invite to attendees on create. */
export function buildGraphEvent(b: BookingRequest, opts: { zoomLink?: string; ownerPhone?: string }): Record<string, unknown> {
  const ev: Record<string, unknown> = {
    subject: b.subject,
    start: { dateTime: new Date(b.start).toISOString(), timeZone: 'UTC' },
    end: { dateTime: new Date(b.end).toISOString(), timeZone: 'UTC' },
    attendees: [{ emailAddress: { address: b.email, name: b.name || b.email }, type: 'required' }],
  };
  if (b.meeting === 'teams') {
    ev.isOnlineMeeting = true;
    ev.onlineMeetingProvider = 'teamsForBusiness';
  } else if (b.meeting === 'zoom' && opts.zoomLink) {
    ev.location = { displayName: 'Zoom' };
    ev.body = {
      contentType: 'HTML',
      content: `Join via Zoom: <a href="${opts.zoomLink}">${opts.zoomLink}</a>`,
    };
  } else if (b.meeting === 'phone') {
    ev.location = { displayName: 'Phone call' };
    const lines: string[] = [];
    if (opts.ownerPhone) lines.push(`Call: ${opts.ownerPhone}`);
    if (b.phone) lines.push(`Attendee phone: ${b.phone}`);
    if (lines.length) ev.body = { contentType: 'HTML', content: lines.join('<br>') };
  }
  return ev;
}

/** Create the event on the owner's mailbox. */
export async function createGraphEvent(
  env: SchedulingEnv,
  token: string,
  eventBody: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.MS_MAILBOX ?? '')}/events`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(eventBody),
      },
    );
    if (res.ok) return { ok: true };
    const detail = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
    console.warn(`graph create ${res.status}: ${detail.slice(0, 400)}`);
    return { ok: false, error: `Calendar API error (${res.status}).` };
  } catch (e) {
    console.warn(`graph create threw: ${e instanceof Error ? e.message : e}`);
    return { ok: false, error: 'Could not reach the calendar API.' };
  }
}
