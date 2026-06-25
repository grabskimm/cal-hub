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
  footer?: string; // optional footer HTML (copyright/link)
  contactHref?: string; // when set, shows a "Contact" link in the top nav
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
  .wrap { max-width: 860px; margin:0 auto; padding: 0 1.1rem 4rem; }
  header.hero { text-align:center; padding: 1rem 1rem 4.4rem; color:#fff;
    background: linear-gradient(135deg, var(--brand) 0%, var(--brand2) 55%, var(--accent) 140%);
    position:relative; overflow:hidden; }
  /* top navigation strip inside the hero (home / contact) — not overlapping the title */
  .topnav { display:flex; align-items:center; gap:.5rem; max-width:920px; margin:0 auto 1.5rem;
    min-height:2.1rem; }
  .topnav .spacer { margin-left:auto; }
  .topnav a { color:#fff; text-decoration:none; font-weight:700; font-size:.84rem; opacity:.94;
    display:inline-flex; gap:.35rem; align-items:center; background:rgba(255,255,255,.16);
    padding:.42rem .8rem; border-radius:99px; backdrop-filter:blur(4px); white-space:nowrap; }
  .topnav a:hover { opacity:1; background:rgba(255,255,255,.28); }
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
  /* Compact, polished timezone dropdown — a real <select> (native dropdown +
     type-ahead) with a custom chevron, sized so it never runs wider than the
     content beside/below it. */
  .field.tzfield { flex:0 0 auto; }
  .field.tzfield select { width:14rem; min-width:0; appearance:none; -webkit-appearance:none;
    padding-right:2.1rem; cursor:pointer; font-weight:600;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
    background-repeat:no-repeat; background-position:right .7rem center; background-size:1rem; }
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
  /* Two distinct cards side by side. The CALENDAR is the primary card and grows
     to fill the row so all seven weekday columns are roomy; the times list is a
     narrower, fixed column beside it (about half the calendar's width). */
  .booklayout { display:flex; gap:1rem; align-items:flex-start; justify-content:center; flex-wrap:wrap; margin-top:1.1rem; }
  .card { border:1px solid var(--line); border-radius:13px; padding:1rem 1.05rem; background:#fcfdff; }
  .calcard { flex:1 1 24rem; min-width:19rem; max-width:36rem; }
  .timecard { flex:0 0 13rem; width:13rem; min-width:0; display:flex; flex-direction:column; }
  .timecard .timescol { overflow-y:auto; max-height:23rem; padding-right:.15rem; }
  @media (max-width:760px){
    .booklayout { flex-direction:column; }
    .calcard { width:100%; max-width:none; flex-basis:auto; }
    .timecard { width:100%; flex-basis:auto; }
    .timecard .timescol { max-height:none; }
  }
  .calhead { display:flex; align-items:center; justify-content:space-between; margin-bottom:.6rem; }
  .calhead .ml { font-weight:800; font-size:1rem; }
  .calhead button { border:1px solid var(--line); background:#fff; border-radius:10px; width:2.2rem; height:2.2rem;
    cursor:pointer; font-size:1.1rem; color:var(--ink); transition:background .15s; }
  .calhead button:hover { background:#f4f5fb; }
  /* minmax(0,1fr) (not 1fr) so the aspect-ratio cells can shrink — otherwise the
     7th column (Saturday) overflows the card and gets clipped. */
  .cal { display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:.28rem; }
  .cal-dow { text-align:center; font-size:.64rem; font-weight:800; letter-spacing:.04em; color:var(--muted); padding:.2rem 0; }
  /* Flatter than square so the month grid stays compact (square cells made the
     calendar much taller than the times column, leaving an uneven panel gap).
     min-height keeps cells tappable on narrow widths where the ratio is short. */
  .cal-cell { aspect-ratio:1.5; min-height:2.4rem; border:0; border-radius:11px; background:transparent; font:inherit; font-weight:700;
    color:var(--ink); display:flex; align-items:center; justify-content:center; cursor:default; transition:transform .08s, background .15s, color .15s; }
  .cal-cell.empty { background:none; }
  .cal-cell.off { color:#c4c8d4; }
  .cal-cell.has { cursor:pointer; background:var(--chip); color:var(--chipink); }
  .cal-cell.has:hover { background:var(--brand); color:#fff; }
  .cal-cell.has:active { transform:translateY(1px); }
  .cal-cell.sel { background:linear-gradient(135deg,var(--brand),var(--brand2)); color:#fff; box-shadow:0 6px 16px rgba(99,102,241,.4); }
  .cal-cell.today:not(.sel) { box-shadow:inset 0 0 0 2px var(--accent); }
  /* times: a clean VERTICAL list inside the times card; slides in when shown */
  .times { display:flex; flex-direction:column; gap:.5rem; animation:slidein .28s ease; }
  .times .chip { width:100%; text-align:center; padding:.7rem .8rem; border-radius:12px; font-weight:700; }
  .picked { font-weight:800; margin:0 0 .7rem; font-size:.95rem; padding-bottom:.6rem;
    border-bottom:1px solid var(--line); animation:slidein .28s ease; }
  .timecard .empty { color:var(--muted); text-align:center; padding:2.4rem 1rem; font-size:.9rem;
    margin:auto; display:flex; align-items:center; justify-content:center; height:100%; }
  @keyframes slidein { from { opacity:0; transform:translateX(16px); } to { opacity:1; transform:none; } }
  footer a { color:var(--brand); text-decoration:none; font-weight:600; }
  footer a:hover { text-decoration:underline; }
  /* ---- mobile ---- */
  @media (max-width:620px){
    header.hero { padding:.7rem .9rem 3.6rem; }
    .topnav { margin-bottom:1.1rem; }
    .topnav a { font-size:.8rem; padding:.38rem .7rem; }
    .wrap { padding:0 .8rem 3rem; }
    .panel { margin-top:-2rem; padding:1rem; border-radius:14px; }
    .controls { gap:.7rem; }
    .field { width:100%; } .field select, .field input { min-width:0; width:100%; }
    .field.tzfield, .field.tzfield select { width:100%; }
    .grow { flex-basis:100%; }
    a.book { margin-left:0; width:100%; justify-content:center; }
    .sheet { border-radius:16px 16px 0 0; align-self:flex-end; max-width:none;
      max-height:90vh; max-height:90dvh; }
    .modal { align-items:flex-end; padding:0; }
  }
  /* modal */
  .modal { position:fixed; inset:0; background:rgba(11,16,32,.45); display:flex; align-items:center;
    justify-content:center; padding:1rem; z-index:50; animation:fade .15s ease; }
  .modal[hidden]{ display:none; }
  .sheet { background:#fff; border-radius:20px; max-width:24rem; width:100%; padding:1.6rem 1.5rem 1.4rem;
    box-shadow:0 30px 80px rgba(2,6,23,.35); position:relative; animation:pop .18s ease; text-align:center;
    display:flex; flex-direction:column; overflow:hidden;
    max-height:calc(100vh - 2rem); max-height:calc(100dvh - 2rem); }
  /* the content scrolls inside the sheet (so a tall form is reachable on mobile),
     while the close button stays pinned; overscroll-contain stops the page behind
     from scrolling instead. */
  .sheet-scroll { overflow-y:auto; overscroll-behavior:contain; -webkit-overflow-scrolling:touch; }
  body.modal-open { overflow:hidden; }
  .sheet .x { position:absolute; top:.6rem; right:.7rem; border:0; background:rgba(255,255,255,.85);
    border-radius:50%; width:1.8rem; height:1.8rem; font-size:1.3rem; z-index:3;
    color:var(--muted); cursor:pointer; line-height:1; }
  .sheet .x:hover { color:var(--ink); }
  .mhead { width:3.1rem; height:3.1rem; margin:.1rem auto .6rem; display:flex; align-items:center; justify-content:center;
    color:#fff; border-radius:16px; background:linear-gradient(135deg,var(--brand),var(--brand2));
    box-shadow:0 10px 22px rgba(99,102,241,.4); }
  .sheet h3 { margin:0 0 .15rem; font-size:1.25rem; letter-spacing:-.01em; }
  .msub { margin:0 0 .9rem; color:var(--muted); font-size:.9rem; }
  .mwhen { display:inline-block; margin:0 auto 1.1rem; background:var(--chip); color:var(--chipink);
    font-weight:700; font-size:.9rem; padding:.45rem .9rem; border-radius:99px; }
  /* the three calendar options sit in a single equal-width row (icon over label) */
  .cal-row { display:flex; flex-direction:row; gap:.5rem; text-align:center; }
  .cal-row .btn { flex:1; min-width:0; flex-direction:column; justify-content:center; align-items:center;
    gap:.3rem; padding:.7rem .4rem; font-weight:700; font-size:.8rem;
    background:#fff; border:1px solid var(--line); color:var(--ink); box-shadow:0 1px 2px rgba(2,6,23,.04); }
  .cal-row .btn:hover { border-color:var(--brand); background:#fafbff; transform:translateY(-1px);
    box-shadow:0 8px 18px rgba(99,102,241,.15); }
  .cal-row .btn .ico { display:inline-flex; justify-content:center; }
  /* editable subject inside the booking modal */
  .msubj-l { display:block; font-size:.66rem; font-weight:700; text-transform:uppercase; letter-spacing:.05em;
    color:var(--muted); text-align:left; margin:0 0 .25rem; }
  .msubj { width:100%; padding:.55rem .7rem; font:inherit; color:var(--ink); border:1px solid var(--line);
    border-radius:10px; margin:0 0 1rem; }
  .msubj:focus { outline:none; border-color:var(--brand); }
  .mfoot { color:var(--muted); font-size:.74rem; margin:1.05rem 0 0; }
  @keyframes fade { from{opacity:0} to{opacity:1} }
  @keyframes pop { from{opacity:0; transform:translateY(8px) scale(.98)} to{opacity:1; transform:none} }
`;

// Populates a <select id=tz> with the browser's IANA zones (grouped by region
// for easy scanning) and selects the local one (or a fallback). Embedded into
// pages that need the timezone picker.
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
  // Put the detected local zone first under a "Detected" group for one-tap use.
  const detected = document.createElement('optgroup'); detected.label = 'Detected';
  const d = document.createElement('option'); d.value = local; d.textContent = local.replace(/_/g,' ');
  d.selected = true; detected.appendChild(d); selectEl.appendChild(detected);
  // Then every zone, grouped by region (Africa, America, Asia, …) for scanning.
  const groups = {};
  for (const z of zones) {
    const region = z.includes('/') ? z.slice(0, z.indexOf('/')) : 'Other';
    (groups[region] = groups[region] || []).push(z);
  }
  for (const region of Object.keys(groups).sort()) {
    const og = document.createElement('optgroup'); og.label = region;
    for (const z of groups[region]) {
      const o = document.createElement('option');
      o.value = z; o.textContent = z.replace(/_/g,' ');
      og.appendChild(o);
    }
    selectEl.appendChild(og);
  }
  return local;
}
`;

// A reusable mini month-calendar picker: pick a date with openings -> times for
// that date -> onTime(slot, tz). Shared by the availability and booking pages.
// opts: { calEl, timesEl, monthLabelEl, prevEl, nextEl, getTz, getSlots, onTime }.
// Returns { refresh } to call after slots load or the timezone changes.
export const CALENDAR_PICKER_JS = `
function createPicker(opts) {
  var view=null, selKey=null;
  var dkey=(iso,tz)=>new Date(iso).toLocaleDateString('en-CA',{timeZone:tz});
  var ym=(y,m)=>y+'-'+String(m+1).padStart(2,'0');
  function group(tz){ var m=new Map(); var ss=opts.getSlots()||[];
    for(var i=0;i<ss.length;i++){ var k=dkey(ss[i].start,tz); if(!m.has(k))m.set(k,[]); m.get(k).push(ss[i]); } return m; }
  function el(t,c,x){ var e=document.createElement(t); if(c)e.className=c; if(x!=null)e.textContent=x; return e; }
  function renderMonth(tz, groups){
    opts.monthLabelEl.textContent = new Date(view.y, view.m, 1).toLocaleDateString([], {month:'long', year:'numeric'});
    var cal=opts.calEl; cal.innerHTML='';
    ['Su','Mo','Tu','We','Th','Fr','Sa'].forEach(d=>cal.appendChild(el('div','cal-dow',d)));
    var first=new Date(view.y, view.m, 1).getDay();
    var dim=new Date(view.y, view.m+1, 0).getDate();
    for(var i=0;i<first;i++) cal.appendChild(el('div','cal-cell empty',''));
    var todayK=new Date().toLocaleDateString('en-CA',{timeZone:tz});
    for(var day=1; day<=dim; day++){
      var key=ym(view.y,view.m)+'-'+String(day).padStart(2,'0');
      var cell=el('button','cal-cell',String(day)); cell.type='button';
      if(key===todayK) cell.classList.add('today');
      if(groups.has(key)){ cell.classList.add('has'); if(key===selKey) cell.classList.add('sel');
        cell.addEventListener('click', (function(k){return function(){ selKey=k; renderMonth(tz,groups); renderTimes(tz,groups); };})(key));
      } else { cell.classList.add('off'); cell.disabled=true; }
      cal.appendChild(cell);
    }
  }
  function renderTimes(tz, groups){
    var t=opts.timesEl; t.innerHTML='';
    if(!selKey || !groups.has(selKey)){ t.appendChild(el('div','empty','Pick a date to see open times.')); return; }
    var slots=groups.get(selKey);
    t.appendChild(el('div','picked', new Date(slots[0].start).toLocaleDateString([], {weekday:'long', month:'long', day:'numeric', timeZone:tz})));
    var wrap=el('div','times','');
    for(var i=0;i<slots.length;i++){ (function(s){
      var b=el('button','chip', new Date(s.start).toLocaleTimeString([], {hour:'numeric', minute:'2-digit', timeZone:tz}));
      b.type='button'; b.addEventListener('click', ()=>opts.onTime(s, tz)); wrap.appendChild(b);
    })(slots[i]); }
    t.appendChild(wrap);
  }
  var didInit=false;
  function refresh(){
    // We deliberately do NOT auto-select a date — the times panel stays a prompt
    // until the user picks a day, then it slides in. Exception: an explicit
    // initialDate (e.g. ?from=) preselects that day once on first load.
    var tz=opts.getTz(); var groups=group(tz); var keys=[...groups.keys()].sort();
    if(selKey && !groups.has(selKey)) selKey=null;
    if(!selKey && !didInit && opts.initialDate && groups.has(opts.initialDate)) selKey=opts.initialDate;
    didInit=true;
    var base = selKey || keys[0] || new Date().toLocaleDateString('en-CA',{timeZone:tz});
    var bp=base.split('-'); if(!view) view={y:+bp[0], m:+bp[1]-1};
    renderMonth(tz, groups); renderTimes(tz, groups);
  }
  opts.prevEl.addEventListener('click', ()=>{ view={y: view.m===0?view.y-1:view.y, m:(view.m+11)%12}; renderMonth(opts.getTz(), group(opts.getTz())); });
  opts.nextEl.addEventListener('click', ()=>{ view={y: view.m===11?view.y+1:view.y, m:(view.m+1)%12}; renderMonth(opts.getTz(), group(opts.getTz())); });
  return { refresh: refresh };
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
    <nav class="topnav">
      <a href="/">⌂ Home</a>
      <span class="spacer"></span>
      ${cfg.contactHref ? `<a href="${escapeHtml(cfg.contactHref)}">✉ Contact</a>` : ''}
    </nav>
    <h1>${escapeHtml(cfg.title)}</h1>
    <p>Choose a day, then a time. Shown in your time zone.</p>
  </header>
  <div class="wrap">
    <div class="panel">
      <div class="controls">
        <div class="field tzfield">
          <label for="tz">Time zone</label>
          <select id="tz"></select>
        </div>
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
    <footer>Availability updates hourly.</footer>
    ${cfg.footer ?? ''}
  </div>

<script>
const CFG = ${cfgJson};
${TZ_PICKER_JS}
${CALENDAR_PICKER_JS}
const $ = (id) => document.getElementById(id);
const tzSel=$('tz'), statusEl=$('status');
let cache = [];
buildTzPicker(tzSel, CFG.fallbackTz);

const picker = createPicker({
  calEl:$('cal'), timesEl:$('times'), monthLabelEl:$('ml'), prevEl:$('prev'), nextEl:$('next'),
  getTz: ()=>tzSel.value, getSlots: ()=>cache,
  onTime: (s)=>{ location.href = '/book?from=' + encodeURIComponent(s.start.slice(0,10)) + '&at=' + encodeURIComponent(s.start); },
});

async function load() {
  statusEl.textContent = 'Loading…';
  try {
    const today = new Date(); const iso=(d)=>d.toISOString().slice(0,10);
    const q = new URLSearchParams({ from: iso(today), to: iso(new Date(today.getTime()+60*864e5)) });
    const res = await fetch('/slots.json?' + q.toString());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    cache = (await res.json()).slots || [];
    statusEl.textContent = cache.length ? '' : 'No open times right now. Check back soon.';
    picker.refresh();
  } catch (e) { statusEl.textContent = 'Could not load availability: ' + e.message; }
}
tzSel.addEventListener('change', ()=>picker.refresh());
load();
</script>
</body>
</html>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}
