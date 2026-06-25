/**
 * Minimal chat-booker UI served at GET /chat on the public host. A simple message
 * thread that POSTs to /chat; the server returns {reply, proposed?, booked?}. The
 * page keeps the last `proposed` slots and echoes them back so the model can
 * resolve "book number 2". First-draft UI — intentionally lightweight.
 */
import { SHARED_CSS, THEME_BTN, THEME_HEAD, THEME_JS, escapeHtml } from './availability-page';

export interface ChatPageCfg {
  heading: string;
  homeHref?: string;
  bookHref?: string;
  footer?: string;
  turnstileSiteKey: string; // '' disables the widget
  greeting: string;
}

export function chatPageHtml(cfg: ChatPageCfg): string {
  const cfgJson = JSON.stringify({ turnstile: !!cfg.turnstileSiteKey, greeting: cfg.greeting });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
${THEME_HEAD}
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(cfg.heading)}</title>
<style>${SHARED_CSS}
  .chatwrap { max-width:640px; }
  .thread { display:flex; flex-direction:column; gap:.6rem; min-height:18rem; max-height:60vh; overflow-y:auto; padding:.3rem; }
  .msg { padding:.6rem .85rem; border-radius:14px; max-width:85%; white-space:pre-wrap; line-height:1.45; font-size:.94rem; }
  .msg.user { align-self:flex-end; background:linear-gradient(135deg,var(--brand),var(--brand2)); color:#fff; border-bottom-right-radius:5px; }
  .msg.bot { align-self:flex-start; background:var(--card2); border:1px solid var(--line); color:var(--ink); border-bottom-left-radius:5px; }
  .msg.typing { color:var(--muted); font-style:italic; }
  .composer { display:flex; gap:.5rem; margin-top:.8rem; }
  .composer input { flex:1; padding:.7rem .9rem; font:inherit; color:var(--ink); background:var(--field); border:1px solid var(--line); border-radius:12px; }
  .composer input:focus { outline:none; border-color:var(--brand); box-shadow:0 0 0 4px var(--ring); }
  .composer button { border:0; cursor:pointer; font:inherit; font-weight:700; color:#fff; padding:.7rem 1.1rem; border-radius:12px;
    background:linear-gradient(135deg,var(--brand),var(--brand2)); }
  .composer button:disabled { opacity:.6; cursor:default; }
  .cf-turnstile { margin:.7rem 0 0; }
  .hint { color:var(--muted); font-size:.8rem; margin:.6rem .2rem 0; }
</style>
${cfg.turnstileSiteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}
</head>
<body>
  <header class="hero">
    <nav class="topnav">
      <a href="${escapeHtml(cfg.homeHref ?? '/')}">⌂ Home</a>
      ${cfg.bookHref ? `<a href="${escapeHtml(cfg.bookHref)}">📅 Booking page</a>` : ''}
      <span class="spacer"></span>
      ${THEME_BTN}
    </nav>
    <h1>${escapeHtml(cfg.heading)}</h1>
    <p>Tell me what you need and I'll find a time.</p>
  </header>
  <div class="wrap chatwrap">
    <div class="panel">
      <div class="thread" id="thread"></div>
      ${cfg.turnstileSiteKey ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(cfg.turnstileSiteKey)}"></div>` : ''}
      <div class="composer">
        <input id="msg" type="text" autocomplete="off" placeholder="e.g. 30 min next week, afternoons…" />
        <button id="send" type="button">Send</button>
      </div>
      <p class="hint">Bookings create a real calendar invite. Be specific about the day and time of day.</p>
    </div>
    ${cfg.footer ?? ''}
  </div>
<script>
${THEME_JS}
const CFG = ${cfgJson};
const $ = (id) => document.getElementById(id);
const thread = $('thread'), input = $('msg'), sendBtn = $('send');
let messages = [], proposed = [], busy = false;

function add(role, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
  d.textContent = text;
  thread.appendChild(d); thread.scrollTop = thread.scrollHeight;
  return d;
}
if (CFG.greeting) add('bot', CFG.greeting);

async function send() {
  const text = input.value.trim();
  if (!text || busy) return;
  let turnstile = '';
  if (CFG.turnstile) {
    const t = document.querySelector('[name=cf-turnstile-response]');
    turnstile = (t && t.value) || '';
    if (!turnstile) { add('bot', 'Please complete the verification below first.'); return; }
  }
  input.value = ''; add('user', text); messages.push({ role: 'user', content: text });
  busy = true; sendBtn.disabled = true;
  const typing = add('bot', '…'); typing.classList.add('typing');
  try {
    const res = await fetch('/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, proposed, turnstile }) });
    const data = await res.json().catch(() => ({}));
    typing.remove();
    const reply = (data && data.reply) || (data && data.error) || 'Sorry, something went wrong.';
    add('bot', reply); messages.push({ role: 'assistant', content: reply });
    if (Array.isArray(data.proposed)) proposed = data.proposed;
    if (data.booked) { input.disabled = true; sendBtn.disabled = true; }
    if (window.turnstile && CFG.turnstile) { try { window.turnstile.reset(); } catch (e) {} }
  } catch (e) {
    typing.remove(); add('bot', 'Network error — please try again.');
  } finally { busy = false; if (!input.disabled) sendBtn.disabled = false; input.focus(); }
}
sendBtn.addEventListener('click', send);
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
input.focus();
</script>
</body>
</html>`;
}
