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
  // The booking + contact pages live on the PUBLIC host, not this private one,
  // so these must be absolute URLs (e.g. https://availability.example/book).
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
      ${cfg.bookHref ? `<a href="${cfg.bookHref}">⌂ Booking page</a>` : ''}
      <span class="spacer"></span>
      ${cfg.contactHref ? `<a href="${cfg.contactHref}">✉ Contact</a>` : ''}
    </nav>
    <h1>${cfg.title}</h1>
    <p>Your busy times across every calendar. Gaps are free.</p>
  </header>
  <div class="wrap calwrap">
    <div class="panel">
      <div class="toolbar">
        <div class="field grow">
          <label for="tz">Time zone</label>
          <select id="tz"></select>
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
      <div class="legend" id="legend"></div>
    </div>
    <div id="status" style="margin:.8rem .2rem;color:var(--muted);font-size:.85rem;">Loading…</div>
    <div class="scroll"><div class="grid" id="grid"></div></div>
    <p class="hint">Tip: swipe horizontally to see the full week on small screens.</p>
    ${cfg.footer ?? ''}
  </div>

<script>
const CFG = ${cfgJson};
// No-op shim for esbuild keepNames' __name() calls embedded via .toString() (see booking.ts).
var __name = function (f) { return f; };
${TZ_PICKER_JS}
${tzParts.toString()}
${labelColor.toString()}

const HOUR_PX = 44, DAY_PX = HOUR_PX * 24;
const token = new URLSearchParams(location.search).get('token') || '';
const tzSel = document.getElementById('tz');
const gridEl = document.getElementById('grid');
const statusEl = document.getElementById('status');
const legendEl = document.getElementById('legend');
let events = [];
let weekStart = null; // YYYY-MM-DD

buildTzPicker(tzSel, CFG.fallbackTz);

function addDays(dayKey, n) {
  const [y,m,d] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(y, m-1, d) + n*864e5).toISOString().slice(0,10);
}
function todayKey(tz) { return tzParts(new Date().toISOString(), tz).dayKey; }
const fmtTime = (s, tz) => new Date(s).toLocaleTimeString([], { hour:'numeric', minute:'2-digit', timeZone: tz });
const colLabel = (dayKey) => new Date(dayKey + 'T12:00:00').toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' });

function render() {
  const tz = tzSel.value;
  if (!weekStart) weekStart = todayKey(tz);
  const today = todayKey(tz);
  const cols = Array.from({length:7}, (_, i) => addDays(weekStart, i));
  gridEl.innerHTML = '';

  // header row
  gridEl.appendChild(el('div','head',''));
  for (const c of cols) gridEl.appendChild(el('div','head' + (c===today?' today':''), colLabel(c)));

  // time gutter
  const gutter = el('div','', '');
  for (let h=0; h<24; h++) {
    const g = el('div','gutcell', h===0?'' : (h%12||12) + (h<12?' AM':' PM'));
    gutter.appendChild(g);
  }
  gridEl.appendChild(gutter);

  // day columns
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
    gridEl.appendChild(body);
  }

  // legend
  legendEl.innerHTML = '';
  for (const l of [...labels].sort()) {
    const k = el('span','k',''); const sw = el('span','sw',''); sw.style.background = labelColor(l);
    k.appendChild(sw); k.appendChild(document.createTextNode(l)); legendEl.appendChild(k);
  }
  statusEl.textContent = events.length + ' busy block(s).';
  // scroll to ~6am on first paint
  const sc = document.querySelector('.scroll'); if (sc && !sc.dataset.scrolled) { sc.scrollTop = 6*HOUR_PX; sc.dataset.scrolled='1'; }
}

function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt) e.textContent = txt; return e; }

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

tzSel.addEventListener('change', render);
document.getElementById('prev').addEventListener('click', () => { weekStart = addDays(weekStart, -7); render(); });
document.getElementById('next').addEventListener('click', () => { weekStart = addDays(weekStart, 7); render(); });
document.getElementById('today').addEventListener('click', () => { weekStart = todayKey(tzSel.value); render(); });
load();
</script>
</body>
</html>`;
}
