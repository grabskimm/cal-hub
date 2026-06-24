// @vitest-environment node
//
// Regression guard for the "__name is not defined" class of bugs: the booking
// page embeds helper functions via .toString(), and Wrangler bundles the Worker
// with esbuild's keepNames, which injects __name(...) calls into those bodies.
// Earlier tests used un-bundled source and missed it, so the modal threw on
// click in production. This test bundles booking.ts EXACTLY like Wrangler
// (keepNames: true, minify: false), runs the real page script in jsdom, clicks
// through, and asserts the launch modal opens with working links.
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

async function loadBundledBookingHtml() {
  const out = buildSync({
    entryPoints: ['src/booking.ts'],
    bundle: true,
    format: 'esm',
    keepNames: true, // <-- Wrangler default; this is what injects __name()
    minify: false, // <-- Wrangler does not minify, so __name keeps its name
    target: 'es2022',
    write: false,
  });
  const code = out.outputFiles[0].text;
  const mod = await import(`data:text/javascript,${encodeURIComponent(code)}`);
  return mod.bookingHtml as (cfg: Record<string, unknown>) => string;
}

describe('booking page (Wrangler-bundled, keepNames)', () => {
  it('opens the launch modal on time-click without a __name ReferenceError', async () => {
    const bookingHtml = await loadBundledBookingHtml();
    const html = bookingHtml({
      owner: 'mendel@mendelg.tech',
      title: 'Intro',
      flavor: 'office',
      tz: 'America/New_York',
      durationMin: '30',
      heading: 'Book a time',
      fallbackTz: 'America/Los_Angeles',
      slotsBase: '',
    });
    // The page must carry the __name no-op shim for the embedded bundled code.
    expect(html).toContain('var __name');

    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const { window } = dom;
    let pageError: string | null = null;
    window.addEventListener('error', (e) => {
      pageError = e.message;
    });
    (window as unknown as { fetch: unknown }).fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ slots: [{ start: '2026-07-15T16:00:00.000Z', end: '2026-07-15T16:30:00.000Z' }] }),
    });
    window.URL.createObjectURL = () => 'blob:ics';
    window.URL.revokeObjectURL = () => {};

    const body = html.match(/<body>([\s\S]*?)<\/body>/)![1].replace(/<script>[\s\S]*?<\/script>/, '');
    window.document.body.innerHTML = body;
    window.eval(html.match(/<script>([\s\S]*?)<\/script>/)![1]);
    await new Promise((r) => setTimeout(r, 200));

    const doc = window.document;
    (doc.querySelector('#cal .cal-cell.has') as HTMLButtonElement).click(); // pick the date
    (doc.querySelector('#times .chip') as HTMLButtonElement).click(); // pick the time

    const modal = doc.getElementById('modal') as HTMLElement;
    expect(pageError).toBeNull(); // no "__name is not defined"
    expect(modal.hidden).toBe(false); // modal actually opened
    expect(doc.querySelectorAll('#cal-row a').length).toBe(3); // Google/Outlook/.ics
    expect(doc.querySelectorAll('#email-row a').length).toBe(3); // Gmail/Outlook/mail
  });
});
