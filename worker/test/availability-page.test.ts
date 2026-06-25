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

  it('does not embed a chat widget unless chat config is provided', () => {
    expect(html).not.toContain('class="panel chatbox"');
    expect(html).not.toContain('initChatWidget(');
  });

  it('embeds the chat widget inline when chat config is given', () => {
    const withChat = availabilityHtml({
      title: 'Find a time with Mendel', fallbackTz: 'UTC',
      chat: { greeting: 'Hi! When works?', turnstileSiteKey: '0xSITEKEY' },
    });
    expect(withChat).toContain('class="panel chatbox"');
    expect(withChat).toContain('class="chat-thread"');
    expect(withChat).toContain('initChatWidget(');
    expect(withChat).toContain('Hi! When works?');
    // Turnstile loader + interaction-only widget when a site key is set.
    expect(withChat).toContain('challenges.cloudflare.com/turnstile');
    expect(withChat).toContain('data-appearance="interaction-only"');
  });
});
