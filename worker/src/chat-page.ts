/**
 * Minimal chat-booker UI served at GET /chat on the public host. A simple message
 * thread that POSTs to /chat; the server returns {reply, proposed?, booked?}. The
 * page keeps the last `proposed` slots and echoes them back so the model can
 * resolve "book number 2". First-draft UI — intentionally lightweight.
 */
import {
  CHAT_WIDGET_CSS,
  CHAT_WIDGET_JS,
  SHARED_CSS,
  THEME_BTN,
  THEME_HEAD,
  THEME_JS,
  TURNSTILE_HEAD,
  chatWidgetMarkup,
  escapeHtml,
} from './availability-page';

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
<style>${SHARED_CSS}${CHAT_WIDGET_CSS}
  .chatwrap { max-width:640px; }
  .chatwrap .chat-thread { min-height:18rem; max-height:60vh; }
</style>
${cfg.turnstileSiteKey ? TURNSTILE_HEAD : ''}
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
    <div class="panel chatbox">
      ${chatWidgetMarkup(cfg.turnstileSiteKey)}
    </div>
    ${cfg.footer ?? ''}
  </div>
<script>
${THEME_JS}
const CFG = ${cfgJson};
${CHAT_WIDGET_JS}
initChatWidget({ root: document.querySelector('.chatbox'), greeting: CFG.greeting, turnstile: CFG.turnstile });
</script>
</body>
</html>`;
}
