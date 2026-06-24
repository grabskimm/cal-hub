/**
 * Embeddable widget script served at `/embed.js` on the public host. A site adds
 * one <script> tag and this injects a responsive iframe to the booking (or
 * availability) page next to it. The iframe origin is derived from the script's
 * own src, so it always points back at this deployment.
 *
 *   <script src="https://availability.example.com/embed.js"
 *           data-view="book" data-height="640" async></script>
 */
export const EMBED_JS = `(function(){
  var s = document.currentScript;
  if (!s) { var all = document.getElementsByTagName('script'); s = all[all.length-1]; }
  var origin;
  try { origin = new URL(s.src).origin; } catch (e) { origin = ''; }
  var view = (s.getAttribute('data-view') || 'book').toLowerCase();
  var path = view === 'availability' ? '/' : '/book';
  var h = s.getAttribute('data-height') || '640';
  var w = s.getAttribute('data-width') || '100%';
  var f = document.createElement('iframe');
  f.src = origin + path;
  f.loading = 'lazy';
  f.title = 'Availability';
  f.style.width = w;
  f.style.height = /^[0-9]+$/.test(h) ? (h + 'px') : h;
  f.style.border = '0';
  f.style.borderRadius = '16px';
  f.style.boxShadow = '0 10px 30px rgba(2,6,23,.12)';
  f.style.maxWidth = '100%';
  s.parentNode.insertBefore(f, s.nextSibling);
})();`;
