import { describe, it, expect } from 'vitest';
import { inspectCandidate, screenCandidates, contextModels } from '../lib/context-guard.js';

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

  it('decodes encoded leaks despite unrelated malformed percent sequences', () => {
    expect(inspectCandidate({ ...clean, title: '100% uptime %FF', content: 'alice%40example.org' }).safe).toBe(false);
  });

  it('accepts repository test and local-config paths without treating them as hosts', () => {
    expect(inspectCandidate({ ...clean, files: ['src/routes/users.test.ts', 'config/env.local.js'] }).safe).toBe(true);
  });

  it('screens file paths before upload', () => {
    const verdict = inspectCandidate({
      ...clean,
      files: ['customers/alice@example.org.ts'],
    });
    expect(verdict.safe).toBe(false);
  });

  it('collects every reason, not just the first', () => {
    const verdict = inspectCandidate({
      title: 'Everything at once',
      content: 'Email ops@acme.com about the 10.0.0.4 box. TODO: fix this.',
    });
    expect(verdict.reasons.length).toBeGreaterThan(2);
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

describe('independent local models', () => {
  const env = { RESTLESS_CONTEXT_EXTRACTION_MODEL: 'claude-haiku-5-5', RESTLESS_CONTEXT_REVIEW_MODEL: 'claude-sonnet-5-5' };
  it('selects different explicit supported model identities', () => {
    expect(contextModels('claude', env)).toEqual({ extraction: 'claude-haiku-5-5', review: 'claude-sonnet-5-5' });
  });
  it('fails closed for missing configuration, same models and unsupported providers', () => {
    expect(() => contextModels('claude', {})).toThrow();
    expect(() => contextModels('claude', { ...env, RESTLESS_CONTEXT_REVIEW_MODEL: env.RESTLESS_CONTEXT_EXTRACTION_MODEL })).toThrow();
    expect(() => contextModels('codex', env)).toThrow();
  });
  it.each(['title', 'description', 'content', 'docsBody', 'endpoint', 'icon'])('checks encoded sensitive %s before upload', (field) => {
    expect(inspectCandidate({ ...clean, [field]: 'alice%40example.org' }).safe).toBe(false);
  });
});
