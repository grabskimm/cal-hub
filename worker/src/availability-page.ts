/**
 * Public availability page served at `/` on the public host. Friendly, branded,
 * read-only: it shows when the owner is FREE (computed from /slots.json), grouped
 * by day, in a timezone the visitor picks from a dropdown (defaults to their
 * local zone). Working hours and slot length are owner-controlled via env, so
 * they are not shown here. Anonymized — no calendar names. Links to /book.
 */
export interface AvailabilityPageCfg {
  title: string; // friendly heading
  fallbackTz: string; // used if the browser can't resolve a local zone
}

// Shared, modern look-and-feel for the public pages.
export const SHARED_CSS = `
  :root {
    --bg:#f6f7fb; --card:#ffffff; --ink:#0b1020; --muted:#6b7280;
    --brand:#6366f1; --brand2:#8b5cf6; --accent:#22d3ee;
    --chip:#eef2ff; --chipink:#4338ca; --ok:#10b981; --line:#eceef3;
    --ring:rgba(99,102,241,.35); --shadow:0 14px 40px rgba(15,23,42,.10);
    --radius:16px;
  }
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body { margin:0; color:var(--ink); background:
      radial-gradient(1200px 500px at 50% -200px, #eef2ff 0%, rgba(238,242,255,0) 60%), var(--bg);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Inter, sans-serif;
    line-height:1.5; -webkit-font-smoothing:antialiased; }
  .wrap { max-width: 920px; margin:0 auto; padding: 0 1.1rem 4rem; }
  header.hero { text-align:center; padding: 3rem 1rem 4.4rem; color:#fff;
    background: linear-gradient(135deg, var(--brand) 0%, var(--brand2) 55%, var(--accent) 140%);
    position:relative; overflow:hidden; }
  header.hero::after { content:""; position:absolute; inset:auto 0 -1px 0; height:48px;
    background:linear-gradient(to bottom, transparent, var(--bg)); }
  header.hero h1 { margin:0 0 .4rem; font-size: clamp(1.5rem, 3.4vw, 2.1rem); letter-spacing:-.02em; font-weight:800; }
  header.hero p { margin:0 auto; max-width:34rem; opacity:.92; font-size:1rem; }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:var(--radius);
    box-shadow:var(--shadow); padding: 1.1rem 1.2rem; margin-top:-2.6rem; backdrop-filter:saturate(1.2); }
  .controls { display:flex; flex-wrap:wrap; gap:.85rem 1rem; align-items:flex-end; }
  .field { display:flex; flex-direction:column; gap:.3rem; }
  .field label { font-size:.7rem; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; }
  .field select, .field input { padding:.6rem .7rem; font:inherit; color:var(--ink);
    border:1px solid var(--line); border-radius:11px; background:#fff; min-width:11.5rem; transition:border-color .15s, box-shadow .15s; }
  .field select:focus, .field input:focus { outline:none; border-color:var(--brand); box-shadow:0 0 0 4px var(--ring); }
  .grow { flex:1 1 14rem; }
  .btn { display:inline-flex; align-items:center; gap:.45rem; border:0; cursor:pointer; font:inherit;
    font-weight:700; padding:.62rem 1rem; border-radius:11px; text-decoration:none; transition:transform .08s, filter .15s, box-shadow .15s; }
  .btn:active { transform:translateY(1px); }
  .btn-primary { background:linear-gradient(135deg, var(--brand), var(--brand2)); color:#fff;
    box-shadow:0 8px 20px rgba(99,102,241,.35); }
  .btn-primary:hover { filter:brightness(1.06); }
  .btn-ghost { background:#fff; color:var(--ink); border:1px solid var(--line); }
  .btn-ghost:hover { background:#fafafe; }
  a.book { margin-left:auto; align-self:center; }
  #status { color:var(--muted); font-size:.85rem; margin:1.3rem .25rem .2rem; }
  .day { margin-top:1.3rem; }
  .day h2 { font-size:.95rem; margin:0 0 .6rem; color:var(--ink); font-weight:700; }
  .chips { display:flex; flex-wrap:wrap; gap:.5rem; }
  .chip { padding:.5rem .8rem; border-radius:12px; background:var(--chip); color:var(--chipink);
    font-size:.92rem; font-weight:700; border:1px solid #e3e8ff; cursor:pointer; transition:transform .08s, background .15s, color .15s, box-shadow .15s; }
  .chip:hover { background:var(--brand); color:#fff; border-color:var(--brand); box-shadow:0 6px 16px rgba(99,102,241,.3); }
  .chip:active { transform:translateY(1px); }
  .chip[aria-pressed=true]{ background:var(--brand); color:#fff; border-color:var(--brand); }
  a.chip { text-decoration:none; }
  .empty { text-align:center; color:var(--muted); padding:2.6rem 1rem; }
  footer { text-align:center; color:var(--muted); font-size:.78rem; margin-top:2.2rem; }
  /* modal */
  .modal { position:fixed; inset:0; background:rgba(11,16,32,.45); display:flex; align-items:center;
    justify-content:center; padding:1rem; z-index:50; animation:fade .15s ease; }
  .modal[hidden]{ display:none; }
  .sheet { background:#fff; border-radius:18px; max-width:30rem; width:100%; padding:1.3rem 1.3rem 1.5rem;
    box-shadow:0 30px 80px rgba(2,6,23,.35); position:relative; animation:pop .18s ease; }
  .sheet h3 { margin:.2rem 0 .1rem; font-size:1.15rem; }
  .sheet .x { position:absolute; top:.6rem; right:.7rem; border:0; background:transparent; font-size:1.4rem;
    color:var(--muted); cursor:pointer; line-height:1; }
  .seg { display:flex; align-items:center; gap:.6rem; margin:1rem 0 .6rem; color:var(--muted); font-size:.74rem;
    text-transform:uppercase; letter-spacing:.06em; font-weight:700; }
  .seg::before, .seg::after { content:""; flex:1; height:1px; background:var(--line); }
  .row { display:grid; grid-template-columns:1fr 1fr; gap:.55rem; }
  .row .btn { width:100%; justify-content:center; }
  .row .btn.full { grid-column:1 / -1; }
  @keyframes fade { from{opacity:0} to{opacity:1} }
  @keyframes pop { from{opacity:0; transform:translateY(8px) scale(.98)} to{opacity:1; transform:none} }
`;

// Populates a <select id=tz> with the browser's IANA zones, selects the local
// one (or a fallback), and exposes window.__tz / a 'change' callback. Embedded
// into pages that need the timezone picker.
export const TZ_PICKER_JS = `
function buildTzPicker(selectEl, fallbackTz) {
  let zones = [];
  try { zones = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : []; } catch (e) {}
  if (!zones.length) zones = ['America/Los_Angeles','America/Denver','America/Chicago',
    'America/New_York','UTC','Europe/London','Europe/Paris','Asia/Kolkata','Asia/Singapore',
    'Asia/Tokyo','Australia/Sydney'];
  let local = fallbackTz;
  try { local = Intl.DateTimeFormat().resolvedOptions().timeZone || fallbackTz; } catch (e) {}
  if (!zones.includes(local)) zones = [local, ...zones];
  selectEl.innerHTML = '';
  for (const z of zones) {
    const o = document.createElement('option');
    o.value = z; o.textContent = z.replace(/_/g,' ');
    if (z === local) o.selected = true;
    selectEl.appendChild(o);
  }
  return local;
}
`;

export function availabilityHtml(cfg: AvailabilityPageCfg): string {
  const cfgJson = JSON.stringify(cfg);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(cfg.title)}</title>
<style>${SHARED_CSS}</style>
</head>
<body>
  <header class="hero">
    <h1>${escapeHtml(cfg.title)}</h1>
    <p>Pick your time zone and a date range to see open times.</p>
  </header>
  <div class="wrap">
    <div class="panel">
      <div class="controls">
        <div class="field grow">
          <label for="tz">Time zone</label>
          <select id="tz"></select>
        </div>
        <div class="field">
          <label for="from">From</label>
          <input type="date" id="from" />
        </div>
        <div class="field">
          <label for="to">To</label>
          <input type="date" id="to" />
        </div>
        <a class="btn btn-primary book" href="/book">Request a time →</a>
      </div>
    </div>
    <div id="status">Loading…</div>
    <div id="out"></div>
    <footer>Times shown in your selected zone. Availability updates hourly.</footer>
  </div>

<script>
const CFG = ${cfgJson};
${TZ_PICKER_JS}
const tzSel = document.getElementById('tz');
const fromEl = document.getElementById('from');
const toEl = document.getElementById('to');
const out = document.getElementById('out');
const statusEl = document.getElementById('status');
let cache = [];

buildTzPicker(tzSel, CFG.fallbackTz);
const isoDate = (d) => d.toISOString().slice(0,10);
const today = new Date();
fromEl.value = isoDate(today);
toEl.value = isoDate(new Date(today.getTime() + 14*864e5));

const fmtTime = (s, tz) => new Date(s).toLocaleTimeString([], { hour:'numeric', minute:'2-digit', timeZone: tz });
const fmtDayKey = (s, tz) => new Date(s).toLocaleDateString('en-CA', { timeZone: tz });
const fmtDayLabel = (s, tz) => new Date(s).toLocaleDateString([], { weekday:'long', month:'long', day:'numeric', timeZone: tz });

function render() {
  const tz = tzSel.value;
  out.innerHTML = '';
  if (!cache.length) { out.innerHTML = '<div class="empty">No open times in this range. Try widening the dates.</div>'; return; }
  const byDay = new Map();
  for (const s of cache) {
    const k = fmtDayKey(s.start, tz);
    if (!byDay.has(k)) byDay.set(k, { label: fmtDayLabel(s.start, tz), slots: [] });
    byDay.get(k).slots.push(s);
  }
  for (const { label, slots } of byDay.values()) {
    const day = document.createElement('div'); day.className = 'day';
    const h = document.createElement('h2'); h.textContent = label; day.appendChild(h);
    const chips = document.createElement('div'); chips.className = 'chips';
    for (const s of slots) {
      const a = document.createElement('a'); a.className = 'chip';
      a.textContent = fmtTime(s.start, tz);
      a.href = '/book?from=' + encodeURIComponent(s.start.slice(0,10));
      chips.appendChild(a);
    }
    day.appendChild(chips); out.appendChild(day);
  }
}

async function load() {
  statusEl.textContent = 'Loading…';
  try {
    const q = new URLSearchParams({ from: fromEl.value, to: toEl.value });
    const res = await fetch('/slots.json?' + q.toString());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    cache = data.slots || [];
    statusEl.textContent = cache.length ? (cache.length + ' open times') : 'No open times in this range.';
    render();
  } catch (e) { statusEl.textContent = 'Could not load availability: ' + e.message; }
}

tzSel.addEventListener('change', render);   // re-render only; slots are tz-independent
fromEl.addEventListener('change', load);
toEl.addEventListener('change', load);
load();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}
