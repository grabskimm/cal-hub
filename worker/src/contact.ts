/**
 * "Contact me" — a tiny note form served at `/contact` on the PUBLIC host, plus
 * a `POST /contact` JSON endpoint that relays the note to the owner's mailbox.
 *
 * Sending is provider-agnostic (Resend by default, SendGrid optional) so the
 * only secret needed is an API key; nothing about the visitor is stored. If no
 * provider is configured the form falls back to a plain mailto: link, so the
 * page is always useful and AvailCal keeps working with zero backend secrets.
 */
import { escapeHtml, SHARED_CSS } from './availability-page';

export interface ContactEnv {
  CONTACT_TO?: string; // mailbox that receives notes
  CONTACT_FROM?: string; // verified sender (required by Resend/SendGrid)
  CONTACT_PROVIDER?: string; // 'resend' (default) | 'sendgrid'
  CONTACT_API_KEY?: string; // provider API key (a Worker secret)
}

export interface ContactMessage {
  name: string;
  email: string;
  message: string;
}

/** True when a server-side relay is configured (otherwise we fall back to mailto). */
export function contactEnabled(env: ContactEnv): boolean {
  return Boolean(env.CONTACT_TO?.trim() && env.CONTACT_FROM?.trim() && env.CONTACT_API_KEY?.trim());
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Validate + normalise an incoming note. Returns an error string when invalid. */
export function validateMessage(m: Partial<ContactMessage>): { ok: true; msg: ContactMessage } | { ok: false; error: string } {
  const name = (m.name ?? '').trim().slice(0, 120);
  const email = (m.email ?? '').trim().slice(0, 200);
  const message = (m.message ?? '').trim().slice(0, 5000);
  if (!message) return { ok: false, error: 'Please include a message.' };
  if (!email || !EMAIL_RE.test(email)) return { ok: false, error: 'Please include a valid email so I can reply.' };
  return { ok: true, msg: { name, email, message } };
}

/** Relay the note to CONTACT_TO via the configured provider. */
export async function sendContact(env: ContactEnv, msg: ContactMessage): Promise<{ ok: boolean; error?: string }> {
  const to = (env.CONTACT_TO ?? '').trim();
  const from = (env.CONTACT_FROM ?? '').trim();
  const key = (env.CONTACT_API_KEY ?? '').trim();
  if (!to || !from || !key) return { ok: false, error: 'Contact is not configured.' };

  const provider = (env.CONTACT_PROVIDER ?? 'resend').trim().toLowerCase();
  const who = msg.name ? `${msg.name} <${msg.email}>` : msg.email;
  const subject = `Website note from ${msg.name || msg.email}`;
  const text = `From: ${who}\n\n${msg.message}`;

  try {
    if (provider === 'sendgrid') {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: from },
          reply_to: { email: msg.email, name: msg.name || undefined },
          subject,
          content: [{ type: 'text/plain', value: text }],
        }),
      });
      return res.ok ? { ok: true } : { ok: false, error: `Mail provider error (${res.status}).` };
    }
    // Default: Resend (https://resend.com) — single POST, clean from Workers.
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text, reply_to: msg.email }),
    });
    return res.ok ? { ok: true } : { ok: false, error: `Mail provider error (${res.status}).` };
  } catch {
    return { ok: false, error: 'Could not reach the mail provider.' };
  }
}

export interface ContactPageCfg {
  heading: string; // e.g. "Contact Mendel"
  homeHref?: string; // back link target (defaults to '/')
  ownerEmail?: string; // used for the mailto: fallback when no relay is configured
  enabled: boolean; // server relay available?
  footer?: string;
}

export function contactHtml(cfg: ContactPageCfg): string {
  const cfgJson = JSON.stringify({ enabled: cfg.enabled, ownerEmail: cfg.ownerEmail ?? '' });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(cfg.heading)}</title>
<style>${SHARED_CSS}
  .form { display:flex; flex-direction:column; gap:.9rem; }
  .form label { font-size:.7rem; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; }
  .form input, .form textarea { width:100%; padding:.7rem .8rem; font:inherit; color:var(--ink);
    border:1px solid var(--line); border-radius:11px; background:#fff; }
  .form input:focus, .form textarea:focus { outline:none; border-color:var(--brand); box-shadow:0 0 0 4px var(--ring); }
  .form textarea { min-height:8rem; resize:vertical; }
  .hp { position:absolute; left:-9999px; }
  .note { color:var(--muted); font-size:.85rem; margin:.2rem 0 0; }
  .ok { color:var(--ok); font-weight:700; }
  .err { color:#dc2626; font-weight:700; }
</style>
</head>
<body>
  <header class="hero">
    <nav class="topnav"><a href="${escapeHtml(cfg.homeHref ?? '/')}">⌂ Home</a><span class="spacer"></span></nav>
    <h1>${escapeHtml(cfg.heading)}</h1>
    <p>Drop a note and it lands straight in my inbox.</p>
  </header>
  <div class="wrap">
    <div class="panel">
      <form class="form" id="form" autocomplete="on">
        <div><label for="name">Your name</label><input type="text" id="name" name="name" /></div>
        <div><label for="email">Your email</label><input type="email" id="email" name="email" required /></div>
        <div><label for="message">Message</label><textarea id="message" name="message" required></textarea></div>
        <input class="hp" type="text" id="company" name="company" tabindex="-1" autocomplete="off" aria-hidden="true" />
        <button class="btn btn-primary" id="send" type="submit">Send message</button>
        <p class="note" id="status"></p>
      </form>
    </div>
    ${cfg.footer ?? ''}
  </div>
<script>
const CFG = ${cfgJson};
const $ = (id)=>document.getElementById(id);
const form=$('form'), statusEl=$('status'), btn=$('send');
function mailtoFallback(){
  const subj = encodeURIComponent('Website note from ' + ($('name').value || $('email').value || 'a visitor'));
  const body = encodeURIComponent($('message').value + '\\n\\n— ' + $('name').value + ' (' + $('email').value + ')');
  location.href = 'mailto:' + encodeURIComponent(CFG.ownerEmail) + '?subject=' + subj + '&body=' + body;
}
form.addEventListener('submit', async (e)=>{
  e.preventDefault();
  if ($('company').value) { statusEl.textContent=''; return; } // honeypot
  if (!$('message').value.trim() || !$('email').value.trim()) {
    statusEl.className='note err'; statusEl.textContent='Please add your email and a message.'; return;
  }
  if (!CFG.enabled) { if (CFG.ownerEmail) return mailtoFallback();
    statusEl.className='note err'; statusEl.textContent='Contact is not configured yet.'; return; }
  btn.disabled=true; statusEl.className='note'; statusEl.textContent='Sending…';
  try {
    const res = await fetch('/contact', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name:$('name').value, email:$('email').value, message:$('message').value }) });
    const data = await res.json().catch(()=>({}));
    if (res.ok) { statusEl.className='note ok'; statusEl.textContent='Thanks — your message is on its way.'; form.reset(); }
    else { statusEl.className='note err'; statusEl.textContent=(data && data.error) || 'Something went wrong. Try again.'; }
  } catch (err) { statusEl.className='note err'; statusEl.textContent='Network error — please try again.'; }
  finally { btn.disabled=false; }
});
</script>
</body>
</html>`;
}
