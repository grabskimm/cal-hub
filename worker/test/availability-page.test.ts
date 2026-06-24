import { describe, expect, it } from 'vitest';

import { availabilityHtml, SHARED_CSS } from '../src/availability-page';

describe('availabilityHtml', () => {
  const html = availabilityHtml({
    title: 'Find a time with Mendel',
    fallbackTz: 'America/Los_Angeles',
    footer: '<footer>© 2026 Mendel Grabski. All rights reserved.</footer>',
  });

  it('shows the personalised title and a month-calendar picker', () => {
    expect(html).toContain('Find a time with Mendel');
    expect(html).toContain('id="cal"');
    expect(html).toContain('id="times"');
    expect(html).toContain('createPicker(');
    expect(html).toContain('/slots.json?');
    expect(html).toContain('/book?from=');
  });

  it('injects the optional footer', () => {
    expect(html).toContain('© 2026 Mendel Grabski. All rights reserved.');
  });

  it('lists each time on its own row (vertical list of full-width chips)', () => {
    expect(SHARED_CSS).toMatch(/\.times\s*\{[^}]*flex-direction:\s*column/);
    expect(SHARED_CSS).toMatch(/\.times \.chip\s*\{[^}]*width:\s*100%/);
  });

  it('puts the times panel on the right and slides it in', () => {
    // Calendly layout: calendar (fixed width) + times column side-by-side,
    // and the times animate in when shown.
    expect(SHARED_CSS).toMatch(/\.booklayout\s*\{[^}]*display:\s*flex/);
    expect(SHARED_CSS).toMatch(/\.times\s*\{[^}]*animation:\s*slidein/);
    expect(SHARED_CSS).toContain('@keyframes slidein');
  });

  it('has a mobile breakpoint', () => {
    expect(SHARED_CSS).toContain('@media (max-width:620px)');
  });
});
