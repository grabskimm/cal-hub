/**
 * Provider-agnostic booking page served at `/book` on the public host. Reads
 * AvailCal's /slots.json (owner working hours, only free times). Selecting a slot
 * opens a modal that LAUNCHES the booker's preferred app prefilled with the time:
 * email the request via Gmail / Outlook / the default Mail app, or add it to
 * Google / Outlook calendar, or download a universal .ics. No write credential,
 * no backend — AvailCal stays read-only. Times show in a tz the visitor picks.
 */
import { SHARED_CSS, TZ_PICKER_JS } from './availability-page';
import { googleCalendarUrl, icsContent, outlookComposeUrl } from './calendar-links';
import { gmailComposeUrl, mailtoUrl, outlookMailUrl } from './email-links';

export interface BookingPageCfg {
  owner: string; // owner email (invitee/guest + email recipient)
  title: string; // default event subject
  flavor: string; // 'office' | 'live'
  tz: string;
  durationMin: string;
  fallbackTz?: string;
  slotsBase?: string; // origin for /slots.json ('' = same origin)
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
<style>${SHARED_CSS}</style>
</head>
<body>
  <header class="hero">
    <h1>Book a time</h1>
    <p>Pick an open slot, then finish in your calendar or email — Apple, Google, or Outlook.</p>
  </header>
  <div class="wrap">
    <div class="panel">
      <div class="controls">
        <div class="field grow"><label for="tz">Time zone</label><select id="tz"></select></div>
        <div class="field"><label for="from">From</label><input type="date" id="from" /></div>
        <div class="field"><label for="to">To</label><input type="date" id="to" /></div>
        <div class="field grow"><label for="title">Subject</label><input type="text" id="title" /></div>
      </div>
    </div>
    <div id="status">Loading…</div>
    <div id="out"></div>
  </div>

  <div id="modal" class="modal" hidden>
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="mtitle">
      <button class="x" id="x" aria-label="Close">×</button>
      <h3 id="mtitle">Finish booking</h3>
      <p class="muted" id="mwhen" style="margin:.1rem 0 0"></p>
      <div class="seg">Email the request</div>
      <div class="row" id="email-row"></div>
      <div class="seg">or add to your calendar</div>
      <div class="row" id="cal-row"></div>
    </div>
  </div>

<script>
const CFG = ${cfgJson};
${TZ_PICKER_JS}
// Embedded verbatim (single source of truth) from calendar-links.ts/email-links.ts.
const googleCalendarUrl = ${googleCalendarUrl.toString()};
const outlookComposeUrl = ${outlookComposeUrl.toString()};
const icsContent = ${icsContent.toString()};
const gmailComposeUrl = ${gmailComposeUrl.toString()};
const outlookMailUrl = ${outlookMailUrl.toString()};
const mailtoUrl = ${mailtoUrl.toString()};

const $ = (id) => document.getElementById(id);
const tzSel=$('tz'), fromEl=$('from'), toEl=$('to'), titleEl=$('title');
const out=$('out'), statusEl=$('status'), modal=$('modal');
let cache=[], icsUrl=null;

buildTzPicker(tzSel, CFG.fallbackTz);
const isoDate = (d) => d.toISOString().slice(0,10);
const today = new Date();
fromEl.value = isoDate(today);
toEl.value = isoDate(new Date(today.getTime()+14*864e5));
titleEl.value = CFG.title || 'Meeting';

const fmtTime = (s, tz) => new Date(s).toLocaleTimeString([], { hour:'numeric', minute:'2-digit', timeZone: tz });
const fmtDayKey = (s, tz) => new Date(s).toLocaleDateString('en-CA', { timeZone: tz });
const fmtDayLabel = (s, tz) => new Date(s).toLocaleDateString([], { weekday:'long', month:'long', day:'numeric', timeZone: tz });

function linkBtn(text, href, opts) {
  const a=document.createElement('a'); a.className='btn '+(opts.cls||'btn-ghost'); a.textContent=text; a.href=href;
  if (opts.download) a.download='booking.ics'; else { a.target='_blank'; a.rel='noopener'; }
  if (opts.full) a.classList.add('full');
  return a;
}

function openModal(s, tz) {
  const subject = titleEl.value || CFG.title || 'Meeting';
  const when = fmtDayLabel(s.start, tz) + ' · ' + fmtTime(s.start, tz) + '–' + fmtTime(s.end, tz) + ' (' + tz + ')';
  const body = "Hi,\\n\\nI'd like to book \\"" + subject + "\\" on " + when + ".\\n\\nThanks!";
  const cfg = { owner: CFG.owner, title: subject };
  if (icsUrl) URL.revokeObjectURL(icsUrl);
  icsUrl = URL.createObjectURL(new Blob([icsContent(s, cfg)], { type:'text/calendar;charset=utf-8' }));

  $('mwhen').textContent = when;
  const er = $('email-row'); er.innerHTML='';
  if (CFG.owner) {
    er.appendChild(linkBtn('Gmail', gmailComposeUrl(CFG.owner, 'Booking request: '+subject, body), { cls:'btn-primary' }));
    er.appendChild(linkBtn('Outlook', outlookMailUrl(CFG.owner, 'Booking request: '+subject, body, CFG.flavor), { cls:'btn-primary' }));
    er.appendChild(linkBtn('Default mail app', mailtoUrl(CFG.owner, 'Booking request: '+subject, body), { full:true }));
  } else {
    er.innerHTML = '<p class="muted" style="grid-column:1/-1;margin:0">No contact email configured.</p>';
  }
  const cr = $('cal-row'); cr.innerHTML='';
  cr.appendChild(linkBtn('Google Calendar', googleCalendarUrl(s, cfg), {}));
  cr.appendChild(linkBtn('Outlook Calendar', outlookComposeUrl(s, cfg, CFG.flavor), {}));
  cr.appendChild(linkBtn('Download .ics (Apple/other)', icsUrl, { download:true, full:true }));

  modal.hidden = false;
}
function closeModal(){ modal.hidden = true; }
$('x').addEventListener('click', closeModal);
modal.addEventListener('click', (e)=>{ if (e.target===modal) closeModal(); });
document.addEventListener('keydown', (e)=>{ if (e.key==='Escape') closeModal(); });

function render() {
  const tz = tzSel.value;
  out.innerHTML='';
  if (!cache.length) { out.innerHTML='<div class="empty">No open times in this range.</div>'; return; }
  const byDay = new Map();
  for (const s of cache) {
    const k = fmtDayKey(s.start, tz);
    if (!byDay.has(k)) byDay.set(k, { label: fmtDayLabel(s.start, tz), slots: [] });
    byDay.get(k).slots.push(s);
  }
  for (const { label, slots } of byDay.values()) {
    const day=document.createElement('div'); day.className='day';
    const h=document.createElement('h2'); h.textContent=label; day.appendChild(h);
    const chips=document.createElement('div'); chips.className='chips';
    for (const s of slots) {
      const b=document.createElement('button'); b.className='chip'; b.type='button';
      b.textContent=fmtTime(s.start, tz);
      b.addEventListener('click', ()=>openModal(s, tz));
      chips.appendChild(b);
    }
    day.appendChild(chips); out.appendChild(day);
  }
}

async function load() {
  statusEl.textContent='Loading…';
  try {
    const q = new URLSearchParams({ from: fromEl.value, to: toEl.value });
    const res = await fetch((CFG.slotsBase||'') + '/slots.json?' + q.toString());
    if (!res.ok) throw new Error('HTTP '+res.status);
    const data = await res.json();
    cache = data.slots || [];
    statusEl.textContent = cache.length ? (cache.length+' open times') : 'No open times in this range.';
    render();
  } catch (e) { statusEl.textContent='Could not load: '+e.message; }
}

tzSel.addEventListener('change', render);
fromEl.addEventListener('change', load);
toEl.addEventListener('change', load);
load();
</script>
</body>
</html>`;
}
