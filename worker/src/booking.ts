/**
 * Provider-agnostic booking page served at `/book` on the public host. It reads
 * AvailCal's own /slots.json (so only genuinely-free times are offered) and, on
 * selecting a slot, offers a universal `.ics` download plus Add-to-Google and
 * Add-to-Outlook quick links — works whatever calendar the booker uses. No write
 * credential, no backend: AvailCal stays read-only and the booked event
 * self-removes from availability on the next hourly merge (it lands on a calendar
 * AvailCal already reads).
 *
 * The Google/Outlook links add you (the owner) as guest/invitee, so those paths
 * notify you on save; the .ics is the universal fallback for any other client.
 */
import { googleCalendarUrl, icsContent, outlookComposeUrl } from './calendar-links';

export interface BookingPageCfg {
  owner: string; // owner email (invitee/guest)
  title: string; // default event subject
  flavor: string; // 'office' | 'live' — which Outlook quick-link to use
  tz: string; // default timezone for slot display + query
  durationMin: string; // default slot length
  slotsBase?: string; // origin for /slots.json ('' = same origin; set when self-hosting)
}

export function bookingHtml(cfg: BookingPageCfg): string {
  const cfgJson = JSON.stringify(cfg);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Book a time</title>
<style>
  :root { font-family: system-ui, sans-serif; }
  body { max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.3rem; }
  form { display: grid; grid-template-columns: repeat(2, 1fr); gap: .5rem 1rem; margin: 1rem 0; }
  label { display: flex; flex-direction: column; font-size: .8rem; gap: .2rem; }
  input { padding: .35rem; font: inherit; }
  .day { margin: 1rem 0; }
  .day h2 { font-size: .95rem; border-bottom: 1px solid #ddd; padding-bottom: .25rem; }
  .slots { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .5rem; }
  button.slot { padding: .4rem .7rem; border: 1px solid #2563eb; background: #eff6ff;
    color: #1e40af; border-radius: 6px; cursor: pointer; font: inherit; }
  button.slot:hover, button.slot[aria-pressed=true] { background: #2563eb; color: #fff; }
  .muted { color: #666; font-size: .8rem; }
  #status { margin: .5rem 0; }
  #actions { position: sticky; bottom: 0; background: #fff; border-top: 1px solid #ddd;
    padding: .75rem 0; margin-top: 1rem; }
  #actions a { display: inline-block; margin-right: .5rem; padding: .45rem .8rem;
    border: 1px solid #16a34a; color: #166534; border-radius: 6px; text-decoration: none; }
  #actions a:hover { background: #16a34a; color: #fff; }
  #actions[hidden] { display: none; }
</style>
</head>
<body>
  <h1>Book a time</h1>
  <p class="muted">Pick an open slot, then add it to your calendar — works with
  Apple, Google, or Outlook. You (the host) are added as an invitee.</p>

  <form id="controls">
    <label>From <input type="date" name="from" /></label>
    <label>To <input type="date" name="to" /></label>
    <label>Timezone <input type="text" name="tz" /></label>
    <label>Slot minutes <input type="number" name="duration" min="5" step="5" /></label>
    <label>Subject <input type="text" name="title" placeholder="Meeting subject" /></label>
  </form>

  <div id="status" class="muted">Loading…</div>
  <div id="out"></div>
  <div id="actions" hidden></div>

<script>
const CFG = ${cfgJson};
// Embedded verbatim from calendar-links.ts (single source of truth), each bound
// to a stable name so a minified bundle can't rename it out from under callers.
const googleCalendarUrl = ${googleCalendarUrl.toString()};
const outlookComposeUrl = ${outlookComposeUrl.toString()};
const icsContent = ${icsContent.toString()};

const form = document.getElementById('controls');
const out = document.getElementById('out');
const statusEl = document.getElementById('status');
const actions = document.getElementById('actions');
let icsUrl = null;

const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date();
form.from.value = iso(today);
form.to.value = iso(new Date(today.getTime() + 7 * 864e5));
form.tz.value = CFG.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
form.duration.value = CFG.durationMin || '30';
form.title.value = CFG.title || 'Meeting';

const fmtTime = (s, tz) => new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: tz });
const fmtDay = (s, tz) => new Date(s).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz });

function selectSlot(s, tz, btn) {
  document.querySelectorAll('button.slot[aria-pressed=true]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  btn.setAttribute('aria-pressed', 'true');
  const cfg = { owner: CFG.owner, title: form.title.value || CFG.title };
  if (icsUrl) URL.revokeObjectURL(icsUrl);
  icsUrl = URL.createObjectURL(new Blob([icsContent(s, cfg)], { type: 'text/calendar;charset=utf-8' }));
  const when = fmtDay(s.start, tz) + ' ' + fmtTime(s.start, tz);
  actions.innerHTML = '';
  const lbl = document.createElement('span'); lbl.className = 'muted';
  lbl.textContent = 'Add ' + when + ' to: '; actions.appendChild(lbl);
  const mk = (text, href, dl) => {
    const a = document.createElement('a'); a.textContent = text; a.href = href;
    if (dl) { a.download = 'booking.ics'; } else { a.target = '_blank'; a.rel = 'noopener'; }
    actions.appendChild(a); return a;
  };
  mk('Download .ics', icsUrl, true);
  mk('Google', googleCalendarUrl(s, cfg), false);
  mk('Outlook', outlookComposeUrl(s, cfg, CFG.flavor), false);
  actions.hidden = false;
}

async function load() {
  const tz = form.tz.value;
  const q = new URLSearchParams({ from: form.from.value, to: form.to.value, tz, duration: form.duration.value });
  statusEl.textContent = 'Loading…';
  out.innerHTML = ''; actions.hidden = true;
  try {
    const res = await fetch((CFG.slotsBase || '') + '/slots.json?' + q.toString());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const slots = data.slots || [];
    statusEl.textContent = slots.length + ' open slot(s).';
    const byDay = new Map();
    for (const s of slots) {
      const k = fmtDay(s.start, data.tz);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(s);
    }
    for (const [day, daySlots] of byDay) {
      const wrap = document.createElement('div'); wrap.className = 'day';
      const h = document.createElement('h2'); h.textContent = day; wrap.appendChild(h);
      const row = document.createElement('div'); row.className = 'slots';
      for (const s of daySlots) {
        const b = document.createElement('button');
        b.className = 'slot'; b.type = 'button'; b.setAttribute('aria-pressed', 'false');
        b.textContent = fmtTime(s.start, data.tz);
        b.addEventListener('click', () => selectSlot(s, data.tz, b));
        row.appendChild(b);
      }
      wrap.appendChild(row); out.appendChild(wrap);
    }
    if (!slots.length) out.innerHTML = '<p class="muted">No open slots in this range.</p>';
  } catch (e) {
    statusEl.textContent = 'Error: ' + e.message;
  }
}
form.addEventListener('change', load);
load();
</script>
</body>
</html>`;
}
