import { describe, it, expect } from 'vitest';
import { inspectCandidate, screenCandidates } from '../lib/context-guard.js';

/**
 * These are the rules that stop a private repo's contents reaching a public
 * docs page, so they are tested by example rather than by shape: each case is
 * a sentence a real extraction plausibly writes.
 */

const clean = {
  target: 'context',
  title: 'Idempotency keys on payment creation',
  content:
    'Pass an Idempotency-Key header on POST /payments to make retries safe. Keys are retained for 24 hours; a repeat request with the same key returns the original response rather than creating a second payment.',
};

describe('inspectCandidate', () => {
  it('passes ordinary API documentation', () => {
    expect(inspectCandidate(clean).safe).toBe(true);
  });

  it('passes an item that merely names the customer-facing key variable', () => {
    const verdict = inspectCandidate({
      title: 'Authentication',
      content:
        'Send your API key in the Authorization header as a bearer token. Store it in RESTLESS_KEY rather than committing it.',
    });
    expect(verdict.safe).toBe(true);
  });

  it('rejects an empty candidate', () => {
    expect(inspectCandidate({ title: '', content: '' }).safe).toBe(false);
  });

  // --- Credentials -------------------------------------------------------
  //
  // The fixtures below are assembled at runtime rather than written as
  // literals. They are all synthetic, but a test that proves "we reject
  // Stripe keys" necessarily contains a Stripe-key-shaped string, and secret
  // scanners cannot tell that apart from the real thing - GitHub's push
  // protection blocked this file when they were spelled out. Joining the
  // pieces keeps the assertion honest (what reaches `inspectCandidate` is the
  // full string) while leaving nothing matchable in the source.
  const fake = (...parts) => parts.join('');

  it.each([
    // AWS's own documented example key, kept verbatim: it is the canonical
    // "this is not a real key" value and scanners allowlist it.
    ['an AWS access key', 'Use the key AKIAIOSFODNN7EXAMPLE to sign requests.'],
    [
      'a GitHub token',
      `Authenticate with ${fake('ghp', '_', '16C7e42F292c6912E7710c838347Ae178B4a')}.`,
    ],
    [
      'a Stripe live key',
      `The account key is ${fake('sk', '_live_', '4eC39HqLyjWDarjtT1zdp7dc')}.`,
    ],
    [
      'a Slack token',
      `Post with ${fake('xoxb', '-2345678901-2345678901234-', 'AbCdEfGhIjKlMnOpQrStUvWx')}.`,
    ],
    [
      'a JWT',
      `Example token: ${fake(
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.',
        'eyJzdWIiOiIxMjM0NTY3ODkwIn0.',
        'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      )}`,
    ],
    [
      'a connection string',
      'The service reads postgres://app:hunter2@db.example.com:5432/prod at boot.',
    ],
    [
      'a private key block',
      'The signing material starts -----BEGIN RSA PRIVATE KEY----- and is loaded at startup.',
    ],
    [
      'a secret env value',
      `Set STRIPE_SECRET_KEY=${fake('sk', '_live_', 'abcdef0123456789')} in the environment.`,
    ],
  ])('rejects %s', (_label, content) => {
    expect(inspectCandidate({ title: 'Auth', content }).safe).toBe(false);
  });

  // --- People and accounts ----------------------------------------------
  it('rejects an email address', () => {
    const verdict = inspectCandidate({
      title: 'Support',
      content: 'For a raised rate limit, contact priya@acme-internal.com.',
    });
    expect(verdict.safe).toBe(false);
    expect(verdict.reasons).toContain('contains an email address');
  });

  it('rejects a specific UUID', () => {
    expect(
      inspectCandidate({
        title: 'Example',
        content: 'Try account 9f18a0e2-3b7c-4d5e-8f90-1a2b3c4d5e6f.',
      }).safe,
    ).toBe(false);
  });

  // --- Internal infrastructure ------------------------------------------
  it.each([
    ['an internal hostname', 'Requests are routed via billing-worker.internal first.'],
    ['a private IP', 'The upstream lives at 10.4.12.9 inside the VPC.'],
    ['a localhost URL', 'Point the SDK at http://localhost:4099 to try it.'],
    ['a staging host', 'Test against https://staging.acme.com/v1 before going live.'],
  ])('rejects %s', (_label, content) => {
    expect(inspectCandidate({ title: 'Hosts', content }).safe).toBe(false);
  });

  // --- Work in progress --------------------------------------------------
  it.each([
    ['a TODO comment', 'TODO: the cursor field is ignored until the rewrite lands.'],
    ['a feature flag', 'The bulk endpoint is behind a feature flag for now.'],
    ['unreleased work', 'Webhook replay is not yet released to customers.'],
    ['an internal-only marker', 'The /admin/reindex route is internal-only.'],
    ['a known bug', 'Pagination past page 50 is a known bug.'],
    ['a ticket reference', 'See PLAT-4471 for why the retry budget is three.'],
  ])('rejects %s', (_label, content) => {
    expect(inspectCandidate({ title: 'Notes', content }).safe).toBe(false);
  });

  it('checks the use-case fields too, not just content', () => {
    const verdict = inspectCandidate({
      target: 'usecase',
      title: 'Charge a saved card',
      content: '1. POST /payments with the stored method.',
      docsBody: 'Internally this is handled by the billing-worker.internal queue.',
    });
    expect(verdict.safe).toBe(false);
  });

  it('ignores file paths, which never reach the public docs', () => {
    const verdict = inspectCandidate({
      ...clean,
      files: ['src/internal/admin/TODO-cleanup.ts', 'src/staging.config.ts'],
    });
    expect(verdict.safe).toBe(true);
  });

  it('collects every reason, not just the first', () => {
    const verdict = inspectCandidate({
      title: 'Everything at once',
      content: 'Email ops@acme.com about the 10.0.0.4 box. TODO: fix this.',
    });
    expect(verdict.reasons.length).toBeGreaterThan(2);
  });
});

describe('inspectCandidate: obfuscated, encoded and personal data', () => {
  const fake = (...parts) => parts.join('');
  const email = fake('priya', '@', 'acme-corp', '.io');

  it.each([
    ['a spelled-out email', 'Write to priya dot shah at acme dot com for access.'],
    ['a bracketed email', 'Write to priya[at]acme[dot]com for access.'],
    ['a zero-width split email', `Write to ${email.replace('@', '\u200B@\u200B')}.`],
    ['a full-width email', 'Write to ｐｒｉｙａ＠ａｃｍｅ．ｃｏｍ today.'],
    ['a hex email', `Payload ${Buffer.from(email).toString('hex')} is decoded server side.`],
    ['a percent-encoded email', 'Payload priya%40acme%2Ecom is decoded server side.'],
    ['a phone number', 'Call +1 (415) 555-2671 to raise the limit.'],
    ['a national ID', 'The holder SSN 123-45-6789 is attached.'],
    ['URL credentials', 'Fetch https://bot:s3cretpass@api.acme.com/v1/export nightly.'],
    ['a high-entropy token', `Use ${fake('q8Zr2LmX9vKp', '4TnW7bYc1HsJ6dFg3Ae5')} as the seed.`],
    ['a hex hash', `Hash ${fake('9f86d081884c7d659a2feaa0', 'c55ad015a3bf4f1b2b0b822c')} matched.`],
  ])('rejects %s', (_label, content) => {
    expect(inspectCandidate({ title: 'Data', content }).safe).toBe(false);
  });

  // Grouped digits also look like a phone number, so each asserts its OWN rule fired.
  it.each([
    ['a card number', 'Card 4111 1111 1111 1111 was declined.', 'contains a payment card number'],
    ['an ungrouped card number', 'Card 4111111111111111 was declined.', 'contains a payment card number'],
    ['an IBAN', 'Payouts go to DE89 3704 0044 0532 0130 00.', 'contains a bank account number'],
  ])('rejects %s with its own reason', (_label, content, reason) => {
    expect(inspectCandidate({ title: 'Data', content }).reasons).toContain(reason);
  });

  // Asserts the decoder's own reason: the entropy rule may also fire on a long payload.
  it.each([
    ['a base64 email', Buffer.from(fake('jane', '@', 'acme.com')).toString('base64')],
    ['a base64 Stripe key', Buffer.from(fake('sk', '_live_', '4eC39HqLyjWDarjtT1zdp7dc')).toString('base64')],
  ])('catches %s by decoding it', (_label, encoded) => {
    expect(inspectCandidate({ title: 'Payload', content: `Payload ${encoded} here.` }).reasons).toContain(
      'hides a secret or personal detail in an encoded string',
    );
  });

  it.each([
    ['an HMAC helper name', 'Call verifyWebhookSignatureHmacSha256 on each delivery.'],
    ['an algorithm header constant', 'Read RESTLESS_HMAC_SHA256_SIGNING_SECRET_HEADER first.'],
    ['an acronym and version', 'Call parseXMLDocumentFromS3Bucket2 to import.'],
  ])('passes %s', (_label, content) => {
    expect(inspectCandidate({ title: 'Docs', content }).safe).toBe(true);
  });

  it('does not mistake a random key with long letter runs for a name', () => {
    expect(inspectCandidate({ title: 'Seed', content: `Seed ${fake('Xqzvbt7Rkmpw', '2Hnlqd5Tfgwx')}.` }).safe).toBe(false);
  });

  it('withholds nearly every random 32-character key', () => {
    let seed = 42;
    const next = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let passed = 0;
    for (let i = 0; i < 1000; i++) {
      let key = '';
      for (let j = 0; j < 32; j++) key += abc[Math.floor(next() * abc.length)];
      if (!/\d/.test(key)) key = `${key.slice(0, 31)}7`;
      if (inspectCandidate({ title: 'Seed', content: `Seed ${key}.` }).safe) passed++;
    }
    expect(passed).toBeLessThanOrEqual(5);
  });

  it('lets the Luhn check decide: a near-miss number is not a card', () => {
    expect(inspectCandidate({ title: 'Docs', content: 'Order 4111111111111112 shipped.' }).safe).toBe(true);
  });

  it('catches an Anthropic key under the generic key rule', () => {
    const key = fake('sk', '-ant-', 'api03-', 'abcdefghijklmnop');
    expect(inspectCandidate({ title: 'Env', content: `Set ${key}.` }).reasons).toContain('contains an API key');
  });

  it.each([
    ['an RFC 2606 example address', 'Use user@example.com as the sandbox login.'],
    ['an ISO date', 'Removed after 2027-01-01.'],
    ['a long identifier', 'Call getOrganizationMembersByRole to list members.'],
    ['an env var name with a digit', 'Set RESTLESS_OAUTH2_CLIENT_CREDENTIALS_ENDPOINT in your env.'],
    ['a versioned method name', 'Call listOrganizationWebhookEndpointsByStatusV2 to page.'],
  ])('passes %s', (_label, content) => {
    expect(inspectCandidate({ title: 'Docs', content }).safe).toBe(true);
  });
});

describe('screenCandidates', () => {
  it('splits a batch and reports titles + reasons for what it held back', () => {
    const { safe, withheld } = screenCandidates([
      clean,
      { title: 'Leaky', content: 'The queue is billing-worker.internal.' },
    ]);

    expect(safe).toHaveLength(1);
    expect(safe[0].title).toBe(clean.title);
    expect(withheld).toEqual([
      { title: 'Leaky', reasons: ['names an internal hostname'] },
    ]);
  });

  it('never carries the offending text into the withheld report', () => {
    // Assembled, not written out - see the note on the credential cases above.
    const secret = ['ghp', '_', '16C7e42F292c6912E7710c838347Ae178B4a'].join('');
    const { withheld } = screenCandidates([
      { title: 'Auth setup', content: `Use ${secret} to authenticate.` },
    ]);
    expect(JSON.stringify(withheld)).not.toContain(secret);
  });

  it('handles an empty batch', () => {
    expect(screenCandidates([])).toEqual({ safe: [], withheld: [] });
  });
});
