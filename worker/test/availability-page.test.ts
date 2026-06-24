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

  it('stacks times vertically (not alongside the calendar)', () => {
    // The times list is a single vertical column with full-width chips.
    expect(SHARED_CSS).toMatch(/\.times\s*\{[^}]*flex-direction:\s*column/);
    expect(SHARED_CSS).toMatch(/\.times \.chip\s*\{[^}]*width:\s*100%/);
  });

  it('places the calendar above the times — never side-by-side', () => {
    // booklayout is a vertical flex column (calendar on top, times below),
    // NOT a 2-column grid that puts times alongside the calendar.
    expect(SHARED_CSS).toMatch(/\.booklayout\s*\{[^}]*flex-direction:\s*column/);
    expect(SHARED_CSS).not.toMatch(/\.booklayout\s*\{[^}]*grid-template-columns/);
  });

  it('has a mobile breakpoint', () => {
    expect(SHARED_CSS).toContain('@media (max-width:620px)');
  });
});
