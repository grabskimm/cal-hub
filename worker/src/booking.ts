/**
 * Provider-agnostic booking page served at `/book` on the public host. Reads
 * AvailCal's /slots.json (owner working hours, only free times). Selecting a slot
 * opens a modal that adds the time to the visitor's calendar: Google / Outlook
 * calendar, or a universal .ics download. No write credential, no backend —
 * AvailCal stays read-only. Times show in a tz the visitor picks.
 */
import { CALENDAR_PICKER_JS, escapeHtml, SHARED_CSS, TZ_PICKER_JS } from './availability-page';
import { googleCalendarUrl, icsContent, outlookComposeUrl } from './calendar-links';

export interface BookingPageCfg {
  owner: string; // owner email (invitee/guest + email recipient)
  title: string; // default event subject
  flavor: string; // 'office' | 'live'
  tz: string;
  durationMin: string;
  heading: string; // hero heading, e.g. "Book a time with Mendel"
  footer?: string; // optional footer HTML (copyright/link)
  homeHref?: string; // "Home" link target (defaults to '/')
  contactHref?: string; // when set, shows a "Contact" link in the top nav
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
    <nav class="topnav">
      <a href="${escapeHtml(cfg.homeHref ?? '/')}">⌂ Home</a>
      <span class="spacer"></span>
      ${cfg.contactHref ? `<a href="${escapeHtml(cfg.contactHref)}">✉ Contact</a>` : ''}
    </nav>
    <h1>${escapeHtml(cfg.heading)}</h1>
    <p>Choose a day, then a time. Shown in your time zone.</p>
  </header>
  <div class="wrap">
    <div class="panel">
      <div class="controls">
        <div class="field tzfield">
          <label for="tz">Time zone</label>
          <input id="tz" list="tz-list" autocomplete="off" spellcheck="false" placeholder="Search time zone…" />
          <datalist id="tz-list"></datalist>
        </div>
        <div class="field grow"><label for="title">Subject</label><input type="text" id="title" /></div>
      </div>
      <div class="booklayout">
        <section class="card calcard">
          <div class="calhead"><button id="prev" aria-label="Previous month">‹</button>
            <span class="ml" id="ml"></span><button id="next" aria-label="Next month">›</button></div>
          <div class="cal" id="cal"></div>
        </section>
        <section class="card timecard"><div class="timescol" id="times"></div></section>
      </div>
    </div>
    <div id="status"></div>
    ${cfg.footer ?? ''}
  </div>

  <div id="modal" class="modal" hidden>
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="mtitle">
      <button class="x" id="x" aria-label="Close">×</button>
      <div class="mhead" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9h18M8 2.5v4M16 2.5v4"/><path d="m9 14 2 2 4-4"/></svg>
      </div>
      <h3 id="mtitle">You're all set</h3>
      <p class="msub">Add it to your calendar</p>
      <p class="mwhen" id="mwhen"></p>
      <div class="cal-row" id="cal-row"></div>
      <p class="mfoot">Opens in your calendar app — nothing is sent to anyone.</p>
    </div>
  </div>

<script>
const CFG = ${cfgJson};
${TZ_PICKER_JS}
${CALENDAR_PICKER_JS}
// esbuild builds the Worker with keepNames, which wraps inner helper functions
// with __name(...) calls and defines __name at the top of the WORKER bundle.
// The functions below are embedded via .toString() into this BROWSER page, so
// their source carries __name(...) calls with no __name in scope. Define a no-op
// shim so the embedded copies run. (Without this, icsContent() throws
// "__name is not defined" on click and the booking modal never opens.)
var __name = function (f) { return f; };
// Embedded verbatim (single source of truth) from calendar-links.ts.
const googleCalendarUrl = ${googleCalendarUrl.toString()};
const outlookComposeUrl = ${outlookComposeUrl.toString()};
const icsContent = ${icsContent.toString()};

const $ = (id) => document.getElementById(id);
const tzSel=$('tz'), titleEl=$('title'), statusEl=$('status'), modal=$('modal');
let cache=[], icsUrl=null;

// Surface any uncaught error on the page itself, so a silent failure becomes
// visible ("nothing happens" -> a readable message) without needing DevTools.
function showErr(msg){ if (statusEl){ statusEl.style.color='#dc2626'; statusEl.textContent='⚠ '+msg; } }
window.addEventListener('error', (e)=> showErr((e && e.message) || 'Unexpected error'));
window.addEventListener('unhandledrejection', (e)=> showErr((e && e.reason && e.reason.message) || 'Unexpected error'));

buildTzPicker(tzSel, CFG.fallbackTz);
titleEl.value = CFG.title || 'Meeting';

const fmtTime = (s, tz) => new Date(s).toLocaleTimeString([], { hour:'numeric', minute:'2-digit', timeZone: tz });
const fmtDayLabel = (s, tz) => new Date(s).toLocaleDateString([], { weekday:'long', month:'long', day:'numeric', timeZone: tz });

function linkBtn(text, href, opts) {
  const a=document.createElement('a'); a.className='btn '+(opts.cls||'btn-ghost'); a.href=href;
  if (opts.icon) { const i=document.createElement('span'); i.className='ico'; i.innerHTML=opts.icon; a.appendChild(i); }
  a.appendChild(document.createTextNode(text));
  if (opts.download) a.download='booking.ics'; else { a.target='_blank'; a.rel='noopener'; }
  if (opts.full) a.classList.add('full');
  return a;
}
// Simple brand-ish glyphs for the calendar choices (kept inline; no external assets).
const ICON_GOOGLE = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="#4285F4" d="M22 12.2c0-.7-.06-1.4-.18-2.06H12v3.9h5.6a4.8 4.8 0 0 1-2.08 3.15v2.6h3.36C20.84 18 22 15.4 22 12.2z"/><path fill="#34A853" d="M12 22c2.7 0 4.97-.9 6.63-2.43l-3.36-2.6c-.93.62-2.12.98-3.27.98-2.52 0-4.65-1.7-5.42-3.98H3.1v2.5A10 10 0 0 0 12 22z"/><path fill="#FBBC05" d="M6.58 13.37a6 6 0 0 1 0-3.83v-2.5H3.1a10 10 0 0 0 0 8.83l3.48-2.5z"/><path fill="#EA4335" d="M12 6.06c1.47 0 2.78.5 3.82 1.5l2.86-2.86A10 10 0 0 0 3.1 7.04l3.48 2.5C7.35 7.27 9.48 6.06 12 6.06z"/></svg>';
const ICON_OUTLOOK = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="#0A66C2" d="M14 4.5h6.2c.44 0 .8.36.8.8v13.4c0 .44-.36.8-.8.8H14V4.5z"/><path fill="#0A66C2" opacity=".5" d="M14 7.8l7 4v-.7l-7-4z"/><path fill="#1A73E8" d="M2 6.2 12.5 4.3c.3-.05.5.16.5.46v14.48c0 .3-.2.51-.5.46L2 17.8V6.2z"/><path fill="#fff" d="M7.3 9.1c-1.7 0-2.7 1.3-2.7 3 0 1.7 1 2.95 2.66 2.95 1.7 0 2.7-1.27 2.7-3.02C9.96 10.3 8.98 9.1 7.3 9.1zm-.02 1.3c.83 0 1.3.7 1.3 1.68 0 1-.47 1.68-1.3 1.68-.8 0-1.3-.7-1.3-1.7 0-.97.5-1.66 1.3-1.66z"/></svg>';
const ICON_ICS = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#475569" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/></svg>';

function openModal(s, tz) {
 try {
  const subject = titleEl.value || CFG.title || 'Meeting';
  const when = fmtDayLabel(s.start, tz) + ' · ' + fmtTime(s.start, tz) + '–' + fmtTime(s.end, tz) + ' (' + tz + ')';
  const cfg = { owner: CFG.owner, title: subject };
  if (icsUrl) URL.revokeObjectURL(icsUrl);
  icsUrl = URL.createObjectURL(new Blob([icsContent(s, cfg)], { type:'text/calendar;charset=utf-8' }));

  $('mwhen').textContent = when;
  const cr = $('cal-row'); cr.innerHTML='';
  cr.appendChild(linkBtn('Google Calendar', googleCalendarUrl(s, cfg), { icon: ICON_GOOGLE }));
  cr.appendChild(linkBtn('Outlook Calendar', outlookComposeUrl(s, cfg, CFG.flavor), { icon: ICON_OUTLOOK }));
  cr.appendChild(linkBtn('Apple / Download .ics', icsUrl, { download:true, icon: ICON_ICS }));

  // Force visibility explicitly — don't rely solely on the [hidden] attribute /
  // CSS, which is the kind of thing that can silently no-op in some setups.
  modal.hidden = false;
  modal.style.display = 'flex';
  statusEl.textContent = '';
 } catch (err) { showErr('Could not open booking options: ' + (err && err.message ? err.message : err)); }
}
function closeModal(){ modal.hidden = true; modal.style.display = 'none'; }
$('x').addEventListener('click', closeModal);
modal.addEventListener('click', (e)=>{ if (e.target===modal) closeModal(); });
document.addEventListener('keydown', (e)=>{ if (e.key==='Escape') closeModal(); });

// If we arrived from the home page with ?from=YYYY-MM-DD, preselect that date so
// the chosen day's times appear straight away.
const fromParam = (new URLSearchParams(location.search).get('from') || '').slice(0, 10);
const picker = createPicker({
  calEl:$('cal'), timesEl:$('times'), monthLabelEl:$('ml'), prevEl:$('prev'), nextEl:$('next'),
  getTz: ()=>tzSel.value, getSlots: ()=>cache,
  onTime: (s, tz)=>{ statusEl.style.color=''; statusEl.textContent='Opening booking options…'; openModal(s, tz); },
  initialDate: fromParam,
});

async function load() {
  statusEl.textContent='Loading…';
  try {
    const today = new Date(); const iso=(d)=>d.toISOString().slice(0,10);
    const q = new URLSearchParams({ from: iso(today), to: iso(new Date(today.getTime()+60*864e5)) });
    const res = await fetch((CFG.slotsBase||'') + '/slots.json?' + q.toString());
    if (!res.ok) throw new Error('HTTP '+res.status);
    cache = (await res.json()).slots || [];
    statusEl.textContent = cache.length ? '' : 'No open times right now. Check back soon.';
    picker.refresh();
    // Came from the availability page with a specific slot (?at=ISO)? Open its
    // booking options straight away — no need to pick the same time twice.
    const at = new URLSearchParams(location.search).get('at');
    if (at) { const slot = cache.find((x)=>x.start===at); if (slot) openModal(slot, tzSel.value); }
  } catch (e) { statusEl.textContent='Could not load: '+e.message; }
}

tzSel.addEventListener('change', ()=>picker.refresh());
load();
</script>
</body>
</html>`;
}
