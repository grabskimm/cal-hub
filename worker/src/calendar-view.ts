/**
 * Token-gated calendar view (private host, /calendar?token=…). A week grid that
 * renders the owner's merged, source-LABELED busy blocks from /busy.json — so
 * you can see at a glance when you're busy/free and which calendar each block
 * came from. Times shown in a timezone you pick (defaults to local).
 *
 * The pure helpers (tzParts, labelColor) are self-contained so they can be unit
 * tested AND embedded verbatim into the page via `.toString()`.
 */
import { SHARED_CSS, TZ_PICKER_JS } from './availability-page';
import { outlookComposeUrl } from './calendar-links';

/** Local calendar date (YYYY-MM-DD) and minutes-from-midnight of a UTC instant in tz. */
export function tzParts(iso: string, tz: string): { dayKey: string; minutes: number } {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(iso))) {
    if (part.type !== 'literal') p[part.type] = part.value;
  }
  const hour = p.hour === '24' ? '00' : p.hour;
  return { dayKey: `${p.year}-${p.month}-${p.day}`, minutes: Number(hour) * 60 + Number(p.minute) };
}

/** Deterministic, distinct-ish colour per source label. */
export function labelColor(label: string): string {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) % 360;
  return `hsl(${h}, 62%, 45%)`;
}

export interface CalendarPageCfg {
  title: string;
  fallbackTz: string;
  footer?: string;
  // The home + booking + contact pages live on the PUBLIC host, not this private
  // one, so these must be absolute URLs (e.g. https://availability.example/book).
  homeHref?: string;
  bookHref?: string;
  contactHref?: string;
}

export function calendarHtml(cfg: CalendarPageCfg): string {
  const cfgJson = JSON.stringify(cfg);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${cfg.title}</title>
<style>${SHARED_CSS}
  .calwrap { max-width:1100px; }
  .toolbar { display:flex; flex-wrap:wrap; gap:.6rem; align-items:flex-end; }
  .nav button { font:inherit; padding:.5rem .8rem; border:1px solid var(--line); background:#fff;
    border-radius:9px; cursor:pointer; }
  .nav button:hover { background:#f8fafc; }
  .viewseg { display:inline-flex; border:1px solid var(--line); border-radius:9px; overflow:hidden; }
  .viewseg button { font:inherit; padding:.5rem .9rem; border:0; border-left:1px solid var(--line);
    background:#fff; cursor:pointer; }
  .viewseg button:first-child { border-left:0; }
  .viewseg button.active { background:var(--brand); color:#fff; }
  #period { font-weight:700; margin:.7rem .2rem 0; }
  /* "now" line across today's column, positioned in the viewer's timezone */
  .nowline { position:absolute; left:0; right:0; height:0; border-top:2px solid #ef4444; z-index:6; pointer-events:none; }
  .nowline::before { content:''; position:absolute; left:-3px; top:-4px; width:7px; height:7px; border-radius:50%; background:#ef4444; }
  /* month grid. NOTE: an explicit display rule overrides the [hidden] attribute,
     so the view switcher's hidden=true would NOT hide these without these
     overrides — otherwise week/month stack on top of each other. */
  .scroll[hidden], .month[hidden] { display:none !important; }
  .month { display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); border:1px solid var(--line);
    border-radius:12px; overflow:hidden; background:#fff; margin-top:.8rem; }
  .month .dow { background:#f8fafc; border-bottom:1px solid var(--line); padding:.4rem; text-align:center;
    font-size:.72rem; font-weight:600; color:var(--muted); }
  .month .cell { min-height:6.4rem; border-right:1px solid var(--line); border-bottom:1px solid var(--line);
    padding:.3rem; cursor:pointer; overflow:hidden; }
  .month .cell:hover { background:#f8fafc; }
  .month .cell.off { background:#fafafa; }
  .month .cell.off .dn { color:var(--muted); }
  .month .cell.today .dn { background:var(--brand); color:#fff; }
  .month .dn { display:inline-flex; align-items:center; justify-content:center; min-width:1.4rem; height:1.4rem;
    border-radius:50%; font-size:.74rem; font-weight:600; }
  .month .mev { margin-top:2px; font-size:.64rem; color:#fff; border-radius:4px; padding:1px 4px;
    overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .month .more { font-size:.62rem; color:var(--muted); margin-top:1px; }
  /* drag-to-select (Day view) -> block time in Outlook */
  .colbody.selectable { cursor:crosshair; }
  .selrange { position:absolute; left:2px; right:2px; background:rgba(99,102,241,.22);
    border:1.5px solid var(--brand); border-radius:6px; z-index:7; pointer-events:none; }
  /* first-tap start marker (touch) */
  .seltap { position:absolute; left:2px; right:2px; height:0; border-top:2px dashed var(--brand);
    z-index:7; pointer-events:none; }
  .seltap::before { content:'start'; position:absolute; left:4px; top:-1.05rem; font-size:.6rem; font-weight:800;
    color:#fff; background:var(--brand); padding:0 .35rem; border-radius:5px; }
  .selpop { position:fixed; inset:0; background:rgba(11,16,32,.45); display:flex; align-items:center;
    justify-content:center; padding:1rem; z-index:60; animation:fade .15s ease; }
  .selpop[hidden] { display:none !important; }
  .selpop-card { background:#fff; border-radius:18px; max-width:23rem; width:100%; padding:1.3rem 1.3rem 1.1rem;
    box-shadow:0 30px 80px rgba(2,6,23,.35); position:relative; }
  .selpop-card .x { position:absolute; top:.5rem; right:.65rem; border:0; background:transparent; font-size:1.3rem;
    color:var(--muted); cursor:pointer; line-height:1; }
  .selpop-h { font-weight:800; font-size:1.05rem; margin-bottom:.2rem; }
  .selpop-when { color:var(--muted); font-size:.9rem; margin-bottom:.85rem; }
  .selpop-card input { width:100%; padding:.6rem .7rem; font:inherit; border:1px solid var(--line);
    border-radius:11px; margin-bottom:.95rem; }
  .selpop-card input:focus { outline:none; border-color:var(--brand); box-shadow:0 0 0 4px var(--ring); }
  .selpop-actions { display:flex; gap:.5rem; justify-content:flex-end; }
  .btn-ghost2, .btn-primary2 { font:inherit; font-weight:700; border-radius:10px; padding:.55rem .95rem;
    cursor:pointer; text-decoration:none; }
  .btn-ghost2 { background:#fff; color:var(--ink); border:1px solid var(--line); }
  .btn-ghost2:hover { background:#f8fafc; }
  .btn-primary2 { background:linear-gradient(135deg,var(--brand),var(--brand2)); color:#fff; border:0;
    display:inline-flex; align-items:center; }
  .btn-primary2:hover { filter:brightness(1.06); }
  @keyframes fade { from{opacity:0} to{opacity:1} }
  /* "new events" notifications */
  .notify { background:#fff; border:1px solid var(--line); border-left:4px solid var(--brand);
    border-radius:12px; box-shadow:var(--shadow); padding:.9rem 1rem; margin-top:1rem; }
  .notify-head { display:flex; align-items:center; gap:.5rem; font-weight:800; font-size:.95rem; }
  .notify-head .count { background:var(--brand); color:#fff; border-radius:99px; padding:.04rem .5rem; font-size:.74rem; }
  .notify-head .dismiss-all { margin-left:auto; font:inherit; font-size:.8rem; border:0; background:transparent;
    color:var(--muted); cursor:pointer; text-decoration:underline; }
  .notify-head .dismiss-all:hover { color:var(--ink); }
  .notify-list { list-style:none; margin:.65rem 0 0; padding:0; display:flex; flex-direction:column; gap:.4rem; }
  .notify-item { display:flex; align-items:center; gap:.6rem; font-size:.85rem; padding:.45rem .55rem;
    border:1px solid var(--line); border-radius:9px; background:#fbfcff; }
  .notify-item .sw { width:.7rem; height:.7rem; border-radius:3px; flex:0 0 auto; }
  .notify-item .src { font-weight:700; }
  .notify-item .when { color:var(--muted); }
  .notify-item .x { margin-left:auto; border:0; background:transparent; color:var(--muted); cursor:pointer;
    font-size:1.15rem; line-height:1; padding:0 .25rem; }
  .notify-item .x:hover { color:var(--ink); }
  .legend { display:flex; flex-wrap:wrap; gap:.6rem; margin:.8rem .2rem 0; font-size:.8rem; color:var(--muted); }
  .legend .k { display:inline-flex; align-items:center; gap:.35rem; }
  .legend .sw { width:.8rem; height:.8rem; border-radius:3px; display:inline-block; }
  .grid { display:grid; grid-template-columns: 3.2rem repeat(7, minmax(5.2rem, 1fr)); border:1px solid var(--line);
    border-radius:12px; overflow:hidden; background:#fff; margin-top:.8rem; min-width:680px; }
  .grid .head { background:#f8fafc; border-bottom:1px solid var(--line); padding:.4rem; text-align:center;
    font-size:.78rem; font-weight:600; }
  .grid .head.today { color:var(--brand); }
  .gutcell { border-bottom:1px dashed var(--line); height:44px; font-size:.66rem; color:var(--muted);
    text-align:right; padding-right:.3rem; }
  .scroll { max-height:70vh; overflow:auto; -webkit-overflow-scrolling:touch; border-radius:12px; }
  .hint { color:var(--muted); font-size:.75rem; margin:.4rem .2rem 0; }
  .colbody { position:relative; border-left:1px solid var(--line); }
  .hourline { height:44px; border-bottom:1px dashed var(--line); }
  .ev { position:absolute; left:2px; right:2px; border-radius:6px; color:#fff; padding:2px 5px;
    font-size:.7rem; overflow:hidden; box-shadow:0 1px 2px rgba(0,0,0,.15); }
  .ev b { font-weight:700; }
  .ev.tent { opacity:.7; background-image: repeating-linear-gradient(45deg, rgba(255,255,255,.25) 0 6px, transparent 6px 12px); }
</style>
</head>
<body>
  <header class="hero">
    <nav class="topnav">
      ${cfg.homeHref ? `<a href="${cfg.homeHref}">⌂ Home</a>` : ''}
      ${cfg.bookHref ? `<a href="${cfg.bookHref}">📅 Booking page</a>` : ''}
      <span class="spacer"></span>
      ${cfg.contactHref ? `<a href="${cfg.contactHref}">✉ Contact</a>` : ''}
    </nav>
    <h1>${cfg.title}</h1>
    <p>Your busy times across every calendar. Gaps are free.</p>
  </header>
  <div class="wrap calwrap">
    <div class="panel">
      <div class="toolbar">
        <div class="field tzfield">
          <label for="tz">Time zone</label>
          <select id="tz"></select>
        </div>
        <div class="field">
          <label>View</label>
          <div class="viewseg">
            <button id="v-day" data-v="day">Day</button>
            <button id="v-week" data-v="week" class="active">Week</button>
            <button id="v-month" data-v="month">Month</button>
          </div>
        </div>
        <div class="field nav">
          <label>&nbsp;</label>
          <div style="display:flex; gap:.4rem;">
            <button id="prev">‹ Prev</button>
            <button id="today">Today</button>
            <button id="next">Next ›</button>
          </div>
        </div>
      </div>
      <div id="period"></div>
      <div class="legend" id="legend"></div>
    </div>
    <div id="notify" class="notify" hidden></div>
    <div id="status" style="margin:.8rem .2rem;color:var(--muted);font-size:.85rem;">Loading…</div>
    <div class="scroll" id="timewrap"><div class="grid" id="grid"></div></div>
    <div class="month" id="month" hidden></div>
    <p class="hint" id="hint">Tip: swipe horizontally to see the full week on small screens.</p>
    ${cfg.footer ?? ''}
  </div>

  <div id="selpop" class="selpop" hidden>
    <div class="selpop-card" role="dialog" aria-modal="true" aria-labelledby="selpop-h">
      <button class="x" id="selpop-x" aria-label="Close">×</button>
      <div class="selpop-h" id="selpop-h">Block this time in Outlook</div>
      <div class="selpop-when" id="selpop-when"></div>
      <input id="selpop-title" placeholder="Title (optional)" autocomplete="off" />
      <div class="selpop-actions">
        <button type="button" id="selpop-cancel" class="btn-ghost2">Cancel</button>
        <a id="selpop-go" class="btn-primary2" target="_blank" rel="noopener">Open in Outlook →</a>
      </div>
    </div>
  </div>

<script>
const CFG = ${cfgJson};
// No-op shim for esbuild keepNames' __name() calls embedded via .toString() (see booking.ts).
var __name = function (f) { return f; };
${TZ_PICKER_JS}
${tzParts.toString()}
${labelColor.toString()}
${outlookComposeUrl.toString()}

const HOUR_PX = 44, DAY_PX = HOUR_PX * 24;
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const token = new URLSearchParams(location.search).get('token') || '';
const tzSel = document.getElementById('tz');
const gridEl = document.getElementById('grid');
const monthEl = document.getElementById('month');
const timeWrap = document.getElementById('timewrap');
const statusEl = document.getElementById('status');
const legendEl = document.getElementById('legend');
const periodEl = document.getElementById('period');
const hintEl = document.getElementById('hint');
const notifyEl = document.getElementById('notify');
let events = [];
let additions = [];     // newly-added busy blocks (notifications)
let view = 'week';      // 'day' | 'week' | 'month'
let anchor = null;      // YYYY-MM-DD reference day

buildTzPicker(tzSel, CFG.fallbackTz);

function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt) e.textContent = txt; return e; }
function addDays(dayKey, n) {
  const [y,m,d] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(y, m-1, d) + n*864e5).toISOString().slice(0,10);
}
function addMonths(dayKey, n) {
  let [y,m] = dayKey.split('-').map(Number);
  const idx = y*12 + (m-1) + n; y = Math.floor(idx/12); m = idx%12 + 1;
  return y + '-' + String(m).padStart(2,'0') + '-01';
}
function startOfWeek(dayKey) { // align to Sunday
  const [y,m,d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m-1, d));
  return new Date(dt.getTime() - dt.getUTCDay()*864e5).toISOString().slice(0,10);
}
function todayKey(tz) { return tzParts(new Date().toISOString(), tz).dayKey; }
function nowMinutes(tz) { return tzParts(new Date().toISOString(), tz).minutes; }
const fmtTime = (s, tz) => new Date(s).toLocaleTimeString([], { hour:'numeric', minute:'2-digit', timeZone: tz });
const colLabel = (dayKey) => new Date(dayKey + 'T12:00:00').toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' });

function columns() {
  if (view === 'day') return [anchor];
  const s = startOfWeek(anchor);
  return Array.from({length:7}, (_, i) => addDays(s, i));
}

function renderLegend(labels) {
  legendEl.innerHTML = '';
  for (const l of [...labels].sort()) {
    const k = el('span','k',''); const sw = el('span','sw',''); sw.style.background = labelColor(l);
    k.appendChild(sw); k.appendChild(document.createTextNode(l)); legendEl.appendChild(k);
  }
}

function renderTimeGrid(tz) {
  const cols = columns();
  const today = todayKey(tz);
  gridEl.style.gridTemplateColumns = '3.2rem repeat(' + cols.length + ', minmax(5.2rem, 1fr))';
  gridEl.style.minWidth = view === 'week' ? '680px' : '0';
  gridEl.innerHTML = '';

  gridEl.appendChild(el('div','head',''));
  for (const c of cols) gridEl.appendChild(el('div','head' + (c===today?' today':''), colLabel(c)));

  const gutter = el('div','', '');
  for (let h=0; h<24; h++) gutter.appendChild(el('div','gutcell', h===0?'' : (h%12||12) + (h<12?' AM':' PM')));
  gridEl.appendChild(gutter);

  const labels = new Set();
  for (const c of cols) {
    const body = el('div','colbody','');
    body.style.height = DAY_PX + 'px';
    for (let h=0; h<24; h++) body.appendChild(el('div','hourline',''));
    for (const ev of events) {
      const s = tzParts(ev.start, tz);
      if (s.dayKey !== c) continue;
      const e = tzParts(ev.end, tz);
      const endMin = (e.dayKey === c) ? e.minutes : 1440;
      const top = (s.minutes/1440)*DAY_PX;
      const hgt = Math.max(16, ((endMin - s.minutes)/1440)*DAY_PX);
      const color = labelColor(ev.source);
      labels.add(ev.source);
      const box = el('div','ev' + (ev.status==='tentative'?' tent':''), '');
      box.style.top = top+'px'; box.style.height = hgt+'px'; box.style.background = color;
      box.innerHTML = '<b></b><br><span></span>';
      box.querySelector('b').textContent = ev.source;
      box.querySelector('span').textContent = fmtTime(ev.start, tz) + '–' + fmtTime(ev.end, tz);
      body.appendChild(box);
    }
    if (c === today) { // current-time line in the viewer's tz
      const nl = el('div','nowline',''); nl.style.top = ((nowMinutes(tz)/1440)*DAY_PX) + 'px';
      body.appendChild(nl);
    }
    if (view === 'day') { body.classList.add('selectable'); enableDaySelect(body, c, tz); }
    gridEl.appendChild(body);
  }
  renderLegend(labels);
  if (!timeWrap.dataset.scrolled) { timeWrap.scrollTop = 6*HOUR_PX; timeWrap.dataset.scrolled = '1'; }
}

function renderMonth(tz) {
  const today = todayKey(tz);
  const month = anchor.slice(0,7);
  const cells = Array.from({length:42}, (_, i) => addDays(startOfWeek(month + '-01'), i));
  monthEl.innerHTML = '';
  for (const d of DOW) monthEl.appendChild(el('div','dow', d));
  const labels = new Set();
  for (const c of cells) {
    const cell = el('div','cell' + (c.slice(0,7)===month?'':' off') + (c===today?' today':''), '');
    cell.appendChild(el('span','dn', String(Number(c.slice(8,10)))));
    const dayEvs = events
      .filter((ev) => tzParts(ev.start, tz).dayKey === c)
      .sort((a,b) => tzParts(a.start, tz).minutes - tzParts(b.start, tz).minutes);
    for (const ev of dayEvs.slice(0,3)) {
      labels.add(ev.source);
      const m = el('div','mev', fmtTime(ev.start, tz) + ' ' + ev.source);
      m.style.background = labelColor(ev.source);
      cell.appendChild(m);
    }
    if (dayEvs.length > 3) cell.appendChild(el('div','more', '+' + (dayEvs.length - 3) + ' more'));
    cell.addEventListener('click', () => { anchor = c; setView('day'); render(); });
    monthEl.appendChild(cell);
  }
  renderLegend(labels);
}

function periodLabel(tz) {
  if (view === 'day') return new Date(anchor + 'T12:00:00').toLocaleDateString([], { weekday:'long', month:'long', day:'numeric', year:'numeric' });
  if (view === 'month') return new Date(anchor + 'T12:00:00').toLocaleDateString([], { month:'long', year:'numeric' });
  const cols = columns();
  return colLabel(cols[0]) + ' – ' + colLabel(cols[6]);
}

function render() {
  const tz = tzSel.value;
  if (!anchor) anchor = todayKey(tz);
  if (view === 'month') {
    timeWrap.hidden = true; monthEl.hidden = false; hintEl.textContent = 'Tip: click a day to open its detailed view.';
    renderMonth(tz);
  } else {
    monthEl.hidden = true; timeWrap.hidden = false;
    hintEl.textContent = view === 'week'
      ? 'Tip: swipe horizontally to see the full week on small screens.'
      : 'Tip: drag across the hours (on a phone: tap the start, then the end) to block that time in Outlook.';
    renderTimeGrid(tz);
  }
  periodEl.textContent = periodLabel(tz);
  statusEl.textContent = events.length + ' busy block(s).';
}

function setView(v) {
  view = v;
  for (const b of document.querySelectorAll('.viewseg button')) b.classList.toggle('active', b.dataset.v === v);
}

// Keep the now-line current without a full re-render (every 60s).
setInterval(() => {
  if (view === 'month') return;
  const nl = gridEl.querySelector('.nowline');
  if (nl) nl.style.top = ((nowMinutes(tzSel.value)/1440)*DAY_PX) + 'px';
}, 60000);

// ---- "new events" notifications (dismissals tracked per-browser) ----
const DISMISS_KEY = 'availcal_dismissed_notifications';
function loadDismissed() { try { return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]')); } catch (e) { return new Set(); } }
function saveDismissed(set) { try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...set])); } catch (e) {} }
function notifKey(n) { return n.source + '|' + n.start + '|' + n.end; }

function renderNotifications() {
  const dismissed = loadDismissed();
  const tz = tzSel.value;
  const items = (additions || []).filter((n) => !dismissed.has(notifKey(n)));
  notifyEl.innerHTML = '';
  if (!items.length) { notifyEl.hidden = true; return; }
  notifyEl.hidden = false;

  const head = el('div','notify-head','');
  head.appendChild(el('span','', '🔔 New busy events'));
  head.appendChild(el('span','count', String(items.length)));
  const all = el('button','dismiss-all','Dismiss all'); all.type = 'button';
  all.addEventListener('click', () => {
    const d = loadDismissed(); items.forEach((n) => d.add(notifKey(n))); saveDismissed(d); renderNotifications();
  });
  head.appendChild(all);
  notifyEl.appendChild(head);

  const list = el('ul','notify-list','');
  for (const n of items) {
    const li = el('li','notify-item','');
    const sw = el('span','sw',''); sw.style.background = labelColor(n.source); li.appendChild(sw);
    li.appendChild(el('span','src', n.source));
    li.appendChild(el('span','when', new Date(n.start).toLocaleString([], { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit', timeZone: tz })));
    const x = el('button','x','×'); x.type = 'button'; x.title = 'Dismiss';
    x.addEventListener('click', () => { const d = loadDismissed(); d.add(notifKey(n)); saveDismissed(d); renderNotifications(); });
    li.appendChild(x);
    list.appendChild(li);
  }
  notifyEl.appendChild(list);
}

async function loadNotifications() {
  try {
    const res = await fetch('/notifications.json?token=' + encodeURIComponent(token));
    if (!res.ok) return;
    const data = await res.json();
    additions = Array.isArray(data) ? data : [];
    renderNotifications();
  } catch (e) { /* notifications are best-effort */ }
}

// ---- drag-to-select an hour range (Day view) -> open it in Outlook ----
const SNAP_MIN = 15;
const selpop = document.getElementById('selpop');
const selTitle = document.getElementById('selpop-title');
const selGo = document.getElementById('selpop-go');
let selStart = null, selEnd = null; // Date objects (UTC instants)

const minLabel = (m) => { const h = Math.floor(m/60), mi = m%60; const ap = h<12?'AM':'PM'; return ((h%12)||12) + ':' + String(mi).padStart(2,'0') + ' ' + ap; };

// Offset (ms) of tz at a given UTC instant, via formatToParts round-trip.
function tzOffset(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle:'h23',
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const p = {}; for (const x of dtf.formatToParts(new Date(utcMs))) if (x.type !== 'literal') p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month-1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}
// Wall-clock (dayKey + minutes) in tz -> the matching UTC instant (DST-safe).
function zonedToUtc(dayKey, minutes, tz) {
  const [Y,M,D] = dayKey.split('-').map(Number);
  const guess = Date.UTC(Y, M-1, D, Math.floor(minutes/60), minutes%60);
  let utc = guess - tzOffset(guess, tz);
  utc = guess - tzOffset(utc, tz); // refine once for DST edges
  return new Date(utc);
}

function updateGoHref() {
  if (!selStart || !selEnd) return;
  const title = (selTitle.value || '').trim();
  selGo.href = outlookComposeUrl(
    { start: selStart.toISOString(), end: selEnd.toISOString() },
    { title: title, owner: '' }, 'office');
}
function openSelPop(dayKey, a, b, tz) {
  selStart = zonedToUtc(dayKey, a, tz); selEnd = zonedToUtc(dayKey, b, tz);
  const day = new Date(dayKey + 'T12:00:00').toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' });
  document.getElementById('selpop-when').textContent = day + ' · ' + minLabel(a) + ' – ' + minLabel(b) + ' (' + tz + ')';
  selTitle.value = ''; updateGoHref();
  selpop.hidden = false; selpop.style.display = 'flex'; selTitle.focus();
}
function closeSel() { selpop.hidden = true; selpop.style.display = 'none'; }
selTitle.addEventListener('input', updateGoHref);
document.getElementById('selpop-x').addEventListener('click', closeSel);
document.getElementById('selpop-cancel').addEventListener('click', closeSel);
selpop.addEventListener('click', (e) => { if (e.target === selpop) closeSel(); });
selGo.addEventListener('click', () => setTimeout(closeSel, 0));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !selpop.hidden) closeSel(); });

function enableDaySelect(body, dayKey, tz) {
  const yToMin = (clientY) => {
    const r = body.getBoundingClientRect();
    const y = Math.max(0, Math.min(DAY_PX, clientY - r.top));
    return Math.max(0, Math.min(1440, Math.round((y/DAY_PX)*1440/SNAP_MIN)*SNAP_MIN));
  };

  // Desktop: click-drag across the hours.
  body.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startMin = yToMin(e.clientY);
    const sel = el('div','selrange',''); body.appendChild(sel);
    const draw = (a, b) => { const lo=Math.min(a,b), hi=Math.max(a,b);
      sel.style.top = (lo/1440*DAY_PX) + 'px'; sel.style.height = Math.max(2, (hi-lo)/1440*DAY_PX) + 'px'; };
    draw(startMin, startMin);
    const move = (ev) => draw(startMin, yToMin(ev.clientY));
    const up = (ev) => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
      const endMin = yToMin(ev.clientY); sel.remove();
      const a = Math.min(startMin, endMin), b = Math.max(startMin, endMin);
      if (b - a >= SNAP_MIN) openSelPop(dayKey, a, b, tz);
    };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });

  // Touch: a drag here scrolls the day, so use tap-the-start then tap-the-end.
  // (A real tap barely moves; a scroll swipe moves a lot — we distinguish them.)
  let tapStart = null, marker = null, t0 = null;
  const clearTap = () => { tapStart = null; if (marker) { marker.remove(); marker = null; } statusEl.textContent = ''; };
  body.addEventListener('touchstart', (e) => {
    const t = e.touches[0]; t0 = { x: t.clientX, y: t.clientY, time: Date.now() };
  }, { passive: true });
  body.addEventListener('touchend', (e) => {
    if (!t0) return; const t = e.changedTouches[0];
    const moved = Math.abs(t.clientX - t0.x) + Math.abs(t.clientY - t0.y);
    const dt = Date.now() - t0.time; t0 = null;
    if (moved > 12 || dt > 700) return; // a scroll/long-hold, not a tap
    const m = yToMin(t.clientY);
    if (tapStart === null) {
      tapStart = m;
      marker = el('div','seltap',''); marker.style.top = (m/1440*DAY_PX) + 'px'; body.appendChild(marker);
      statusEl.textContent = 'Tap the end time to block it →';
    } else {
      const a = Math.min(tapStart, m), b = Math.max(tapStart, m); clearTap();
      if (b - a >= SNAP_MIN) openSelPop(dayKey, a, b, tz);
    }
  }, { passive: true });
}

async function load() {
  statusEl.textContent = 'Loading…';
  try {
    const res = await fetch('/busy.json?token=' + encodeURIComponent(token));
    if (res.status === 403) { statusEl.textContent = 'Invalid or missing token.'; return; }
    if (res.status === 404) {
      events = []; render();
      statusEl.textContent = 'No calendar data yet — trigger a sync (POST /run) or wait for the hourly update.';
      return;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    events = await res.json();
    render();
  } catch (e) { statusEl.textContent = 'Could not load: ' + e.message; }
}

tzSel.addEventListener('change', () => { render(); renderNotifications(); });
document.getElementById('prev').addEventListener('click', () => {
  anchor = view === 'day' ? addDays(anchor, -1) : view === 'month' ? addMonths(anchor, -1) : addDays(anchor, -7);
  render();
});
document.getElementById('next').addEventListener('click', () => {
  anchor = view === 'day' ? addDays(anchor, 1) : view === 'month' ? addMonths(anchor, 1) : addDays(anchor, 7);
  render();
});
document.getElementById('today').addEventListener('click', () => { anchor = todayKey(tzSel.value); render(); });
for (const id of ['day','week','month']) {
  document.getElementById('v-' + id).addEventListener('click', () => { setView(id); render(); });
}
load();
loadNotifications();
</script>
</body>
</html>`;
}
