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
  // "Book it for me" path (create the event on the owner's calendar). When
  // enabled is false the modal only shows the add-to-your-own-calendar links.
  scheduling?: {
    enabled: boolean;
    zoom: boolean; // offer the Zoom option (a personal link is configured)
    phone: string; // owner's phone for the "Phone" option ('' = option hidden)
    turnstileSiteKey: string; // '' disables the Turnstile widget
  };
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
<style>${SHARED_CSS}
  .req { margin-top:1rem; padding-top:1rem; border-top:1px solid var(--line); text-align:left; }
  .req h4 { margin:0 0 .2rem; font-size:.95rem; }
  .req .rsub { margin:0 0 .7rem; color:var(--muted); font-size:.82rem; }
  .req label { display:block; font-size:.68rem; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin:.5rem 0 .2rem; }
  .req input[type=text], .req input[type=email], .req input[type=tel] { width:100%; padding:.6rem .7rem; font:inherit; color:var(--ink); border:1px solid var(--line); border-radius:10px; }
  .req .rphone-note { font-size:.78rem; color:var(--muted); margin:.4rem 0 0; text-align:left; }
  .req input:focus { outline:none; border-color:var(--brand); }
  .req .mtg { display:flex; gap:.8rem; flex-wrap:wrap; margin-top:.3rem; }
  .req .mtg label { display:inline-flex; align-items:center; gap:.35rem; text-transform:none; letter-spacing:0; font-weight:500; font-size:.85rem; color:var(--ink); margin:0; }
  .req .hp { position:absolute; left:-9999px; }
  .req .rstatus { font-size:.83rem; margin:.5rem 0 0; }
  .req .rstatus.ok { color:var(--ok); font-weight:700; }
  .req .rstatus.err { color:#dc2626; font-weight:700; }
  .req .cf-turnstile { margin:.6rem 0; }
  #confirmed .okmark { color:#16a34a; }
  #confirmed h3 { margin:.2rem 0 .1rem; }
</style>
${cfg.scheduling?.enabled && cfg.scheduling.turnstileSiteKey
  ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
  : ''}
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
          <select id="tz"></select>
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
      <div class="sheet-scroll">
      <div id="book-body">
      <div class="mhead" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9h18M8 2.5v4M16 2.5v4"/><path d="m9 14 2 2 4-4"/></svg>
      </div>
      <h3 id="mtitle">You're all set</h3>
      <p class="msub">Add it to your calendar</p>
      <p class="mwhen" id="mwhen"></p>
      <label class="msubj-l" for="m-subject">Subject</label>
      <input class="msubj" id="m-subject" type="text" placeholder="Meeting" />
      <div class="cal-row" id="cal-row"></div>
      <p class="mfoot">Opens in your calendar app — nothing is sent to anyone.</p>
      ${cfg.scheduling?.enabled ? `
      <div class="req" id="req">
        <h4>Or have me put it on the calendar</h4>
        <p class="rsub">I'll create the event and email you an invite.</p>
        <label for="r-email">Your email</label>
        <input type="email" id="r-email" autocomplete="email" placeholder="you@example.com" />
        <label for="r-name">Your name (optional)</label>
        <input type="text" id="r-name" autocomplete="name" />
        <label>Meeting</label>
        <div class="mtg">
          <label><input type="radio" name="mtg" value="teams" checked /> Teams</label>
          ${cfg.scheduling.zoom ? '<label><input type="radio" name="mtg" value="zoom" /> Zoom</label>' : ''}
          ${cfg.scheduling.phone ? '<label><input type="radio" name="mtg" value="phone" /> Phone</label>' : ''}
          <label><input type="radio" name="mtg" value="none" /> No link</label>
        </div>
        ${cfg.scheduling.phone ? `
        <div id="r-phone-wrap" hidden>
          <label for="r-phone">Your phone (optional)</label>
          <input type="tel" id="r-phone" autocomplete="tel" placeholder="+1 555 123 4567" />
          <p class="rphone-note">I'll call you at the number you give, or reach me at <b>${escapeHtml(cfg.scheduling.phone)}</b>.</p>
        </div>` : ''}
        <input class="hp" type="text" id="r-company" tabindex="-1" autocomplete="off" aria-hidden="true" />
        ${cfg.scheduling.turnstileSiteKey
          ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(cfg.scheduling.turnstileSiteKey)}"></div>`
          : ''}
        <button class="btn btn-primary full" id="r-send" type="button">Send booking request</button>
        <p class="rstatus" id="r-status"></p>
      </div>` : ''}
      </div>
      ${cfg.scheduling?.enabled ? `
      <div id="confirmed" hidden>
        <div class="mhead okmark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/></svg>
        </div>
        <h3>You're booked!</h3>
        <p class="mwhen" id="c-when"></p>
        <p class="msub">We emailed an invite to <b id="c-email"></b>.</p>
        <button class="btn btn-primary full" id="c-done" type="button">Done</button>
      </div>` : ''}
      </div>
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
let cache=[], icsUrl=null, currentSlot=null;

// Surface any uncaught error on the page itself, so a silent failure becomes
// visible ("nothing happens" -> a readable message) without needing DevTools.
function showErr(msg){ if (statusEl){ statusEl.style.color='#dc2626'; statusEl.textContent='⚠ '+msg; } }
window.addEventListener('error', (e)=> showErr((e && e.message) || 'Unexpected error'));
window.addEventListener('unhandledrejection', (e)=> showErr((e && e.reason && e.reason.message) || 'Unexpected error'));

buildTzPicker(tzSel, CFG.fallbackTz);
titleEl.value = CFG.title || 'Meeting';
// Editing the subject in the modal re-targets the calendar links live.
if ($('m-subject')) $('m-subject').addEventListener('input', renderCalRow);

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

// Build (or rebuild) the three calendar links from the modal's editable subject,
// so changing the subject updates the Google/Outlook/.ics targets live.
function renderCalRow() {
  if (!currentSlot) return;
  const subj = (($('m-subject') && $('m-subject').value.trim()) || CFG.title || 'Meeting');
  const cfg = { owner: CFG.owner, title: subj };
  if (icsUrl) URL.revokeObjectURL(icsUrl);
  icsUrl = URL.createObjectURL(new Blob([icsContent(currentSlot, cfg)], { type:'text/calendar;charset=utf-8' }));
  const cr = $('cal-row'); cr.innerHTML='';
  cr.appendChild(linkBtn('Google', googleCalendarUrl(currentSlot, cfg), { icon: ICON_GOOGLE }));
  cr.appendChild(linkBtn('Outlook', outlookComposeUrl(currentSlot, cfg, CFG.flavor), { icon: ICON_OUTLOOK }));
  cr.appendChild(linkBtn('Apple', icsUrl, { download:true, icon: ICON_ICS }));
}

function openModal(s, tz) {
 try {
  currentSlot = s;
  const subject = (titleEl && titleEl.value) || CFG.title || 'Meeting';
  const ms = $('m-subject'); if (ms) ms.value = subject;
  $('mwhen').textContent = fmtDayLabel(s.start, tz) + ' · ' + fmtTime(s.start, tz) + '–' + fmtTime(s.end, tz) + ' (' + tz + ')';
  renderCalRow();

  // Force visibility explicitly — don't rely solely on the [hidden] attribute /
  // CSS, which is the kind of thing that can silently no-op in some setups.
  modal.hidden = false;
  modal.style.display = 'flex';
  document.body.classList.add('modal-open'); // lock background scroll (mobile)
  const sc = modal.querySelector('.sheet-scroll'); if (sc) sc.scrollTop = 0;
  statusEl.textContent = '';
  // Reset the "book it for me" form + a fresh Turnstile token for each slot.
  if (CFG.scheduling && CFG.scheduling.enabled) {
    const rs = $('r-status'); if (rs) rs.textContent = '';
    const bb = $('book-body'), cf = $('confirmed'); if (bb) bb.hidden = false; if (cf) cf.hidden = true;
    const pw = $('r-phone-wrap'); if (pw) pw.hidden = true; // default meeting is Teams
    if (window.turnstile && CFG.scheduling.turnstileSiteKey) { try { window.turnstile.reset(); } catch(e){} }
  }
 } catch (err) { showErr('Could not open booking options: ' + (err && err.message ? err.message : err)); }
}
function closeModal(){ modal.hidden = true; modal.style.display = 'none'; document.body.classList.remove('modal-open'); }
$('x').addEventListener('click', closeModal);
modal.addEventListener('click', (e)=>{ if (e.target===modal) closeModal(); });

// "Book it for me" → POST /book (the server creates the event + emails the invite).
if (CFG.scheduling && CFG.scheduling.enabled) {
  const sendBtn = $('r-send');
  // Reveal the booker's phone field only when "Phone" is chosen.
  const phoneWrap = $('r-phone-wrap');
  document.querySelectorAll('input[name=mtg]').forEach((r)=> r.addEventListener('change', ()=>{
    const m = document.querySelector('input[name=mtg]:checked');
    if (phoneWrap) phoneWrap.hidden = !(m && m.value === 'phone');
  }));
  sendBtn.addEventListener('click', async ()=>{
    const st = $('r-status');
    if (!currentSlot) { st.className='rstatus err'; st.textContent='Pick a time first.'; return; }
    const email = ($('r-email').value||'').trim();
    if (!email) { st.className='rstatus err'; st.textContent='Please enter your email.'; return; }
    const meetingEl = document.querySelector('input[name=mtg]:checked');
    const meeting = meetingEl ? meetingEl.value : 'none';
    let turnstile = '';
    if (CFG.scheduling.turnstileSiteKey) {
      const tIn = document.querySelector('[name=cf-turnstile-response]');
      turnstile = (tIn && tIn.value) || '';
      if (!turnstile) { st.className='rstatus err'; st.textContent='Please complete the verification.'; return; }
    }
    sendBtn.disabled=true; st.className='rstatus'; st.textContent='Sending…';
    try {
      const res = await fetch((CFG.slotsBase||'') + '/book', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          start: currentSlot.start, end: currentSlot.end, email,
          name: ($('r-name').value||'').trim(),
          subject: (($('m-subject') && $('m-subject').value.trim()) || titleEl.value || CFG.title || 'Meeting'),
          meeting, phone: ($('r-phone') ? $('r-phone').value.trim() : ''),
          company: ($('r-company').value||''), turnstile,
        }),
      });
      const data = await res.json().catch(()=>({}));
      if (res.ok) {
        // Swap the modal to a confirmation screen.
        $('c-when').textContent = $('mwhen').textContent;
        $('c-email').textContent = email;
        $('book-body').hidden = true;
        $('confirmed').hidden = false;
      } else {
        st.className='rstatus err'; st.textContent=(data && data.error) || 'Could not book. Try again.';
        if (window.turnstile) { try { window.turnstile.reset(); } catch(e){} }
      }
    } catch (e) { st.className='rstatus err'; st.textContent='Network error — please try again.'; }
    finally { sendBtn.disabled=false; }
  });
  const done = $('c-done'); if (done) done.addEventListener('click', closeModal);
}
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
