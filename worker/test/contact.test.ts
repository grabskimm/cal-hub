import { afterEach, describe, expect, it, vi } from 'vitest';

import { contactEnabled, contactHtml, sendContact, validateMessage } from '../src/contact';

const FULL = { CONTACT_TO: 'me@corp.com', CONTACT_FROM: 'bot@corp.com', CONTACT_API_KEY: 'k_123' };

describe('contactEnabled', () => {
  it('needs to/from/key all present', () => {
    expect(contactEnabled(FULL)).toBe(true);
    expect(contactEnabled({ CONTACT_TO: 'me@corp.com', CONTACT_FROM: 'bot@corp.com' })).toBe(false);
    expect(contactEnabled({})).toBe(false);
  });
});

describe('validateMessage', () => {
  it('requires a message and a valid email', () => {
    expect(validateMessage({ email: 'a@b.com', message: '' }).ok).toBe(false);
    expect(validateMessage({ email: 'nope', message: 'hi' }).ok).toBe(false);
    const v = validateMessage({ name: '  Mendel ', email: 'a@b.com', message: '  hello  ' });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.msg.name).toBe('Mendel'); // trimmed
      expect(v.msg.message).toBe('hello');
    }
  });
  it('caps field lengths', () => {
    const v = validateMessage({ email: 'a@b.com', message: 'x'.repeat(9000) });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.msg.message.length).toBe(5000);
  });
});

describe('sendContact', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs to Resend by default with a reply-to', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await sendContact(FULL, { name: 'A', email: 'a@b.com', message: 'hi' });
    expect(res.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.to).toEqual(['me@corp.com']);
    expect(body.reply_to).toBe('a@b.com');
  });

  it('uses SendGrid when selected', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    await sendContact({ ...FULL, CONTACT_PROVIDER: 'sendgrid' }, { name: 'A', email: 'a@b.com', message: 'hi' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.sendgrid.com/v3/mail/send');
  });

  it('reports provider failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    const res = await sendContact(FULL, { name: 'A', email: 'a@b.com', message: 'hi' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/500/);
  });
});

describe('contactHtml', () => {
  it('renders the form and a mailto fallback when no relay is configured', () => {
    const html = contactHtml({ heading: 'Contact Mendel', enabled: false, ownerEmail: 'me@corp.com' });
    expect(html).toContain('Contact Mendel');
    expect(html).toContain('id="message"');
    expect(html).toContain('mailtoFallback');
    expect(html).toContain('"enabled":false');
  });
});
