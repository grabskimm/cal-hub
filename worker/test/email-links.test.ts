import { describe, expect, it } from 'vitest';

import { gmailComposeUrl, mailtoUrl, outlookMailUrl } from '../src/email-links';

describe('email links', () => {
  it('gmail compose carries recipient, subject, body', () => {
    const url = gmailComposeUrl('me@x.com', 'Booking: Intro', 'on Tue at 9');
    expect(url.startsWith('https://mail.google.com/mail/?')).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get('to')).toBe('me@x.com');
    expect(q.get('su')).toBe('Booking: Intro');
    expect(q.get('body')).toBe('on Tue at 9');
    expect(q.get('view')).toBe('cm');
  });

  it('outlook mail compose switches office/live', () => {
    expect(outlookMailUrl('m@x.com', 's', 'b', 'office')).toContain('outlook.office.com/mail/deeplink/compose');
    expect(outlookMailUrl('m@x.com', 's', 'b', 'live')).toContain('outlook.live.com/mail/0/deeplink/compose');
  });

  it('mailto encodes recipient + query', () => {
    const url = mailtoUrl('me@x.com', 'Hi there', 'line one');
    expect(url.startsWith('mailto:me%40x.com?')).toBe(true);
    expect(url).toContain('subject=Hi+there');
    expect(url).toContain('body=line+one');
  });
});
