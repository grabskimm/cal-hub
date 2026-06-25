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
  chat?: { heading: string; greeting: string; turnstileSiteKey: string }; // when set, embeds the chat booker as a pop-up
}

// Light/dark theming, shared across every page. THEME_HEAD goes first in <head>
// so the saved/OS theme is applied before paint (no flash); THEME_BTN is the
// toggle (drop into the top nav); THEME_JS wires the click (include in the page
// script). The dark palette lives in SHARED_CSS / each page's :root[data-theme].
export const THEME_HEAD = `<script>(function(){try{var t=localStorage.getItem('availcal-theme');var d=t||((window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light');document.documentElement.dataset.theme=d;}catch(e){}})();</script>`;
export const THEME_BTN = `<button id="theme-toggle" class="theme-toggle" type="button" aria-label="Toggle dark mode" title="Toggle light/dark">◐</button>`;
export const THEME_JS = `(function(){var b=document.getElementById('theme-toggle');if(!b)return;b.addEventListener('click',function(){var d=document.documentElement;var n=(d.dataset.theme==='dark')?'light':'dark';d.dataset.theme=n;try{localStorage.setItem('availcal-theme',n);}catch(e){}});})();`;

// Shared, modern look-and-feel for the public pages.
export const SHARED_CSS = `
  :root {
    --bg:#f6f7fb; --glow:#eef2ff; --card:#ffffff; --card2:#fcfdff; --field:#ffffff;
    --hover:#f4f5fb; --off:#c4c8d4; --chipborder:#e3e8ff;
    --ink:#0b1020; --muted:#6b7280;
    --brand:#6366f1; --brand2:#8b5cf6; --accent:#22d3ee;
    --chip:#eef2ff; --chipink:#4338ca; --ok:#10b981; --line:#eceef3;
    --ring:rgba(99,102,241,.35); --shadow:0 14px 40px rgba(15,23,42,.10);
    --hero-grad: linear-gradient(135deg,#6366f1 0%,#8b5cf6 55%,#22d3ee 140%);
    --radius:16px;
  }
  /* Dark theme: a cohesive deep-purple palette that aligns with the brand hero
     (the hero gradient is muted in dark via --hero-grad so it doesn't blast a
     bright purple slab against the dark body). Applied via data-theme on <html>
     by an early inline script (no flash); a toggle flips it. */
  :root[data-theme="dark"] {
    --bg:#0c0a18; --glow:rgba(124,108,255,.14); --card:#17132b; --card2:#120f24; --field:#1e1838;
    --hover:#241d40; --off:#4a4470; --chipborder:#312a52;
    --ink:#e9e7f3; --muted:#a09ab8;
    --brand:#8b8cf8; --brand2:#a78bfa; --accent:#22d3ee;
    --chip:#241c47; --chipink:#cdc7fb; --ok:#34d399; --line:#2c2747;
    --ring:rgba(139,140,248,.4); --shadow:0 18px 50px rgba(0,0,0,.6);
    --hero-grad: linear-gradient(135deg,#2a2363 0%,#3a2a63 55%,#163a52 140%);
  }
  * { box-sizing:border-box; }
  /* Reserve the scrollbar gutter on BOTH sides so a page with a vertical
     scrollbar centers identically to one without it (otherwise centered content
     shifts ~15px between pages). overflow-x:clip kills any stray horizontal
     overflow that would let the page scroll sideways and look off-center, without
     clipping fixed-position UI (the chat pop-up). */
  html { -webkit-text-size-adjust:100%; scrollbar-gutter:stable both-edges; }
  body { margin:0; overflow-x:clip; color:var(--ink); background:
      radial-gradient(1200px 500px at 50% -200px, var(--glow) 0%, rgba(238,242,255,0) 60%), var(--bg);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Inter, sans-serif;
    line-height:1.5; -webkit-font-smoothing:antialiased; }
  .wrap { max-width: 860px; margin:0 auto; padding: 0 1.1rem 4rem; }
  header.hero { text-align:center; padding: 1rem 1.1rem 4.4rem; color:#fff;
    background: var(--hero-grad);
    position:relative; overflow:hidden; }
  /* top navigation strip inside the hero (home / contact) — not overlapping the title */
  .topnav { display:flex; align-items:center; gap:.5rem; max-width:860px; margin:0 auto 1.5rem;
    min-height:2.1rem; }
  .topnav .spacer { margin-left:auto; }
  .topnav a { color:#fff; text-decoration:none; font-weight:700; font-size:.84rem; opacity:.94;
    display:inline-flex; gap:.35rem; align-items:center; background:rgba(255,255,255,.16);
    padding:.42rem .8rem; border-radius:99px; backdrop-filter:blur(4px); white-space:nowrap; }
  .topnav a:hover { opacity:1; background:rgba(255,255,255,.28); }
  .theme-toggle { color:#fff; background:rgba(255,255,255,.16); border:0; cursor:pointer; width:2.1rem; height:2.1rem;
    border-radius:99px; font-size:1.05rem; line-height:1; display:inline-flex; align-items:center; justify-content:center;
    backdrop-filter:blur(4px); }
  .theme-toggle:hover { background:rgba(255,255,255,.28); }
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
    border:1px solid var(--line); border-radius:11px; background:var(--field); min-width:11.5rem; transition:border-color .15s, box-shadow .15s; }
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
  .btn-ghost { background:var(--field); color:var(--ink); border:1px solid var(--line); }
  .btn-ghost:hover { background:var(--hover); }
  a.book { margin-left:auto; align-self:center; }
  #status { color:var(--muted); font-size:.85rem; margin:1.3rem .25rem .2rem; }
  .day { margin-top:1.3rem; }
  .day h2 { font-size:.95rem; margin:0 0 .6rem; color:var(--ink); font-weight:700; }
  .chips { display:flex; flex-wrap:wrap; gap:.5rem; }
  .chip { padding:.5rem .8rem; border-radius:12px; background:var(--chip); color:var(--chipink);
    font-size:.92rem; font-weight:700; border:1px solid var(--chipborder); cursor:pointer; transition:transform .08s, background .15s, color .15s, box-shadow .15s; }
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
  .card { border:1px solid var(--line); border-radius:13px; padding:1rem 1.05rem; background:var(--card2); }
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
  .calhead button { border:1px solid var(--line); background:var(--field); border-radius:10px; width:2.2rem; height:2.2rem;
    cursor:pointer; font-size:1.1rem; color:var(--ink); transition:background .15s; }
  .calhead button:hover { background:var(--hover); }
  /* minmax(0,1fr) (not 1fr) so the aspect-ratio cells can shrink — otherwise the
     7th column (Saturday) overflows the card and gets clipped. */
  .cal { display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:.4rem; }
  .cal-dow { text-align:center; font-size:.64rem; font-weight:800; letter-spacing:.04em; color:var(--muted); padding:.2rem 0; }
  /* Flatter than square so the month grid stays compact (square cells made the
     calendar much taller than the times column, leaving an uneven panel gap).
     min-height keeps cells tappable on narrow widths where the ratio is short. */
  .cal-cell { position:relative; aspect-ratio:1.5; min-height:2.4rem; border:0; border-radius:11px; background:transparent; font:inherit; font-weight:700;
    color:var(--ink); display:flex; align-items:center; justify-content:center; cursor:default; transition:transform .08s, background .15s, color .15s; }
  .cal-cell.empty { background:none; }
  .cal-cell.off { color:var(--off); }
  .cal-cell.has { cursor:pointer; background:var(--chip); color:var(--chipink); }
  /* z-index so the active cell sits above neighbours; tight shadow so the glow
     doesn't bleed onto adjacent dates (was overlapping, esp. in the embed iframe). */
  .cal-cell.has:hover { background:var(--brand); color:#fff; z-index:1; }
  .cal-cell.has:active { transform:translateY(1px); }
  .cal-cell.sel { background:linear-gradient(135deg,var(--brand),var(--brand2)); color:#fff; z-index:2; }
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
  .sheet { background:var(--card); border-radius:20px; max-width:24rem; width:100%; padding:1.6rem 1.5rem 1.4rem;
    box-shadow:0 30px 80px rgba(2,6,23,.35); position:relative; animation:pop .18s ease; text-align:center;
    display:flex; flex-direction:column; overflow:hidden;
    max-height:calc(100vh - 2rem); max-height:calc(100dvh - 2rem); }
  /* the content scrolls inside the sheet (so a tall form is reachable on mobile),
     while the close button stays pinned; overscroll-contain stops the page behind
     from scrolling instead. */
  .sheet-scroll { overflow-y:auto; overscroll-behavior:contain; -webkit-overflow-scrolling:touch; }
  body.modal-open { overflow:hidden; }
  .sheet .x { position:absolute; top:.6rem; right:.7rem; border:0; background:var(--card);
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
    background:var(--field); border:1px solid var(--line); color:var(--ink); box-shadow:0 1px 2px rgba(2,6,23,.04); }
  .cal-row .btn:hover { border-color:var(--brand); background:var(--hover); transform:translateY(-1px);
    box-shadow:0 8px 18px rgba(99,102,241,.15); }
  .cal-row .btn .ico { display:inline-flex; justify-content:center; }
  /* editable subject inside the booking modal */
  .msubj-l { display:block; font-size:.66rem; font-weight:700; text-transform:uppercase; letter-spacing:.05em;
    color:var(--muted); text-align:left; margin:0 0 .25rem; }
  .msubj { width:100%; padding:.55rem .7rem; font:inherit; color:var(--ink); background:var(--field); border:1px solid var(--line);
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

// ---- Shared chat-booker widget ----------------------------------------------
// A small message thread + composer that POSTs to /chat and renders {reply,
// proposed?, booked?}. Used both standalone (the /chat page) and embedded inline
// on the availability page. All CSS is scoped under .chatbox and the JS finds its
// elements within a root node (by class, not global id) so multiple/embedded
// instances never collide with the host page.
export const CHAT_WIDGET_CSS = `
  .chatbox { display:flex; flex-direction:column; }
  .chatbox-title { font-size:.95rem; margin:0 0 .6rem; font-weight:700; color:var(--ink); }
  .chatbox .chat-thread { display:flex; flex-direction:column; gap:.6rem; min-height:11rem; max-height:46vh; overflow-y:auto; padding:.3rem; }
  .chatbox .chat-msg { padding:.6rem .85rem; border-radius:14px; max-width:85%; white-space:pre-wrap; line-height:1.45; font-size:.94rem; }
  .chatbox .chat-msg.user { align-self:flex-end; background:linear-gradient(135deg,var(--brand),var(--brand2)); color:#fff; border-bottom-right-radius:5px; }
  .chatbox .chat-msg.bot { align-self:flex-start; background:var(--card2); border:1px solid var(--line); color:var(--ink); border-bottom-left-radius:5px; }
  .chatbox .chat-msg.typing { color:var(--muted); font-style:italic; }
  .chatbox .chat-composer { display:flex; gap:.5rem; margin-top:.8rem; }
  .chatbox .chat-input { flex:1; padding:.7rem .9rem; font:inherit; color:var(--ink); background:var(--field); border:1px solid var(--line); border-radius:12px; }
  .chatbox .chat-input:focus { outline:none; border-color:var(--brand); box-shadow:0 0 0 4px var(--ring); }
  .chatbox .chat-send { border:0; cursor:pointer; font:inherit; font-weight:700; color:#fff; padding:.7rem 1.1rem; border-radius:12px;
    background:linear-gradient(135deg,var(--brand),var(--brand2)); }
  .chatbox .chat-send:disabled { opacity:.6; cursor:default; }
  .chatbox .cf-turnstile { display:flex; justify-content:center; margin:.5rem 0 0; min-height:0; }
  .chatbox .cf-turnstile:empty { margin:0; }
  .chatbox .chat-hint { color:var(--muted); font-size:.8rem; margin:.6rem .2rem 0; }
`;

// The Turnstile loader <script>, included in <head> only when a site key is set.
export const TURNSTILE_HEAD = `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`;

/** Inner markup for a chat widget (caller wraps it in an element with class "chatbox"). */
export function chatWidgetMarkup(turnstileSiteKey: string): string {
  return `<div class="chat-thread"></div>
      <div class="chat-composer">
        <input class="chat-input" type="text" autocomplete="off" placeholder="e.g. 30 min next week, afternoons…" />
        <button class="chat-send" type="button">Send</button>
      </div>
      ${turnstileSiteKey ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(turnstileSiteKey)}" data-appearance="interaction-only" data-size="flexible"></div>` : ''}
      <p class="chat-hint">Bookings create a real calendar invite. Be specific about the day and time of day.</p>`;
}

// initChatWidget({ root, greeting, turnstile, endpoint? }) — wires one widget.
export const CHAT_WIDGET_JS = `
function initChatWidget(opts) {
  var root = opts.root; if (!root) return;
  var endpoint = opts.endpoint || '/chat';
  var useTurnstile = !!opts.turnstile;
  var thread = root.querySelector('.chat-thread');
  var input = root.querySelector('.chat-input');
  var sendBtn = root.querySelector('.chat-send');
  var messages = [], proposed = [], seen = [], busy = false;
  function add(role, text) {
    var d = document.createElement('div');
    d.className = 'chat-msg ' + (role === 'user' ? 'user' : 'bot');
    d.textContent = text; thread.appendChild(d); thread.scrollTop = thread.scrollHeight; return d;
  }
  if (opts.greeting) add('bot', opts.greeting);
  async function send() {
    var text = input.value.trim(); if (!text || busy) return;
    var turnstile = '';
    if (useTurnstile) {
      var t = root.querySelector('[name=cf-turnstile-response]') || document.querySelector('[name=cf-turnstile-response]');
      turnstile = (t && t.value) || '';
      if (!turnstile) { add('bot', "Just a sec — finishing a quick security check. Please resend in a moment (complete the check below if one appears)."); return; }
    }
    input.value = ''; add('user', text); messages.push({ role: 'user', content: text });
    busy = true; sendBtn.disabled = true;
    var typing = add('bot', '…'); typing.classList.add('typing');
    try {
      var res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: messages, proposed: proposed, seen: seen, turnstile: turnstile }) });
      var data = await res.json().catch(function(){ return {}; });
      typing.remove();
      var reply = (data && data.reply) || (data && data.error) || 'Sorry, something went wrong.';
      add('bot', reply); messages.push({ role: 'assistant', content: reply });
      if (Array.isArray(data.proposed)) {
        proposed = data.proposed;
        // Remember everything we've shown so "more times" never repeats a slot.
        for (var i = 0; i < proposed.length; i++) { if (seen.indexOf(proposed[i].start) < 0) seen.push(proposed[i].start); }
      }
      if (data.booked) { input.disabled = true; sendBtn.disabled = true; }
      if (window.turnstile && useTurnstile) { try { window.turnstile.reset(); } catch (e) {} }
    } catch (e) { typing.remove(); add('bot', 'Network error — please try again.'); }
    finally { busy = false; if (!input.disabled) sendBtn.disabled = false; input.focus(); }
  }
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });
}
`;

// ---- Floating chat launcher (a FAB that opens a docked sidebar popup) --------
// Used to embed the chat as a bottom-right pop-up sidebar instead of inline. The
// inner chatbox is the same shared widget; this only adds the launcher + panel
// chrome and a small open/close toggle.
export const CHAT_FAB_CSS = `
  .chat-fab { position:fixed; right:1.1rem; bottom:1.1rem; z-index:60; border:0; cursor:pointer;
    display:inline-flex; align-items:center; gap:.5rem; font:inherit; font-weight:700; color:#fff;
    padding:.8rem 1.15rem; border-radius:99px; background:linear-gradient(135deg,var(--brand),var(--brand2));
    box-shadow:0 10px 28px rgba(99,102,241,.45); transition:filter .15s, transform .08s; }
  .chat-fab:hover { filter:brightness(1.06); } .chat-fab:active { transform:translateY(1px); }
  .chat-fab .ico { font-size:1.15rem; line-height:1; }
  .chat-popup { position:fixed; right:1.1rem; bottom:1.1rem; z-index:61; width:380px; max-width:calc(100vw - 2rem);
    height:min(560px, calc(100vh - 2rem)); height:min(560px, calc(100dvh - 2rem));
    display:flex; flex-direction:column; background:var(--card); border:1px solid var(--line); border-radius:18px;
    box-shadow:0 24px 70px rgba(2,6,23,.4); overflow:hidden; animation:pop .18s ease; }
  .chat-popup[hidden] { display:none; }
  .chat-popup-head { display:flex; align-items:center; justify-content:space-between; gap:.5rem;
    padding:.8rem 1rem; color:#fff; font-weight:700; font-size:.95rem;
    background:linear-gradient(135deg,var(--brand),var(--brand2)); }
  .chat-popup-x { border:0; background:transparent; color:#fff; font-size:1.45rem; line-height:1; cursor:pointer; padding:.1rem .35rem; opacity:.9; }
  .chat-popup-x:hover { opacity:1; }
  .chat-popup .chatbox { flex:1; min-height:0; padding:1rem 1.1rem; overflow:hidden; }
  .chat-popup .chat-thread { flex:1; min-height:0; max-height:none; }
  @media (max-width:620px){
    .chat-fab { right:.9rem; bottom:.9rem; }
    .chat-popup { right:0; left:0; bottom:0; width:auto; max-width:none; height:86vh; height:86dvh; border-radius:18px 18px 0 0; }
  }
`;

/** Wrap the inner chat widget markup in a FAB + docked popup. */
export function chatFabMarkup(innerMarkup: string, label: string): string {
  return `<button class="chat-fab" id="chatFab" type="button" aria-label="Open chat"><span class="ico">💬</span> Chat</button>
  <div class="chat-popup" id="chatPopup" role="dialog" aria-label="${escapeHtml(label)}" hidden>
    <div class="chat-popup-head"><span>${escapeHtml(label)}</span>
      <button class="chat-popup-x" id="chatPopupX" type="button" aria-label="Close chat">×</button></div>
    <div class="chatbox">
      ${innerMarkup}
    </div>
  </div>`;
}

// Toggle for the FAB/popup. The widget itself is wired separately (initChatWidget).
export const CHAT_FAB_JS = `
(function(){
  var fab=document.getElementById('chatFab'), pop=document.getElementById('chatPopup'), x=document.getElementById('chatPopupX');
  if(!fab||!pop) return;
  function open(){ pop.hidden=false; fab.style.display='none'; var i=pop.querySelector('.chat-input'); if(i) try{ i.focus(); }catch(e){} }
  function close(){ pop.hidden=true; fab.style.display=''; }
  fab.addEventListener('click', open);
  if(x) x.addEventListener('click', close);
  document.addEventListener('keydown', function(e){ if(e.key==='Escape' && !pop.hidden) close(); });
})();
`;

export function availabilityHtml(cfg: AvailabilityPageCfg): string {
  const cfgJson = JSON.stringify(cfg);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
${THEME_HEAD}
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(cfg.title)}</title>
<style>${SHARED_CSS}${cfg.chat ? CHAT_WIDGET_CSS + CHAT_FAB_CSS : ''}</style>
${cfg.chat && cfg.chat.turnstileSiteKey ? TURNSTILE_HEAD : ''}
</head>
<body>
  <header class="hero">
    <nav class="topnav">
      <a href="/">⌂ Home</a>
      <span class="spacer"></span>
      ${cfg.contactHref ? `<a href="${escapeHtml(cfg.contactHref)}">✉ Contact</a>` : ''}
      ${THEME_BTN}
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
    ${cfg.footer ?? ''}
  </div>
  ${cfg.chat ? chatFabMarkup(chatWidgetMarkup(cfg.chat.turnstileSiteKey), cfg.chat.heading) : ''}

<script>
${THEME_JS}
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
${cfg.chat ? `${CHAT_WIDGET_JS}${CHAT_FAB_JS}
initChatWidget({ root: document.querySelector('.chatbox'), greeting: CFG.chat.greeting, turnstile: ${cfg.chat.turnstileSiteKey ? 'true' : 'false'} });` : ''}
</script>
</body>
</html>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}
