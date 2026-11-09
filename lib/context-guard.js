/**
 * The rules that don't depend on a model behaving.
 *
 * `context` runs three checks before a candidate can reach the inbox, and this
 * is the middle one:
 *
 *   1. the extraction pass, on this machine, told to write only public docs;
 *   2. a redaction pass - an independent model call that sees ONLY the
 *      extracted text, plus this module;
 *   3. an adversarial safety review on the server, by a different model.
 *
 * Steps 1 and 3 are judgement. This is arithmetic. A model that has been
 * reading a private codebase for ten minutes is exactly the thing you cannot
 * ask "did you leak anything?", so the patterns most likely to end a career -
 * a live key, an internal hostname, a customer's email - are matched here,
 * where behaviour is not a variable.
 *
 * Everything it catches is DROPPED, never redacted. A candidate with its
 * secret starred out still tells the reader that there is a secret, what it is
 * called, and where it lives, and the fact it was worth mentioning at all
 * means the extraction misunderstood the job. The caller reports what was
 * dropped locally, so the pass is visible without the text going anywhere.
 *
 * A LEAF module: no imports at all.
 */

/**
 * Each rule is [name, regex, why]. Ordered roughly by how bad it would be.
 *
 * These are deliberately blunt. A false positive costs one withheld sentence,
 * which the developer sees named in the summary and can re-word; a false
 * negative is on the public internet.
 */
const RULES = [
  // --- Credentials. Non-negotiable. ---------------------------------------
  ['private key', /-----BEGIN[A-Z ]*PRIVATE KEY-----/, 'contains a private key block'],
  ['aws key', /\bAKIA[0-9A-Z]{16}\b/, 'contains what looks like an AWS access key'],
  ['github token', /\bgh[pousr]_[A-Za-z0-9]{16,}\b/, 'contains a GitHub token'],
  ['slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, 'contains a Slack token'],
  ['openai key', /\bsk-[A-Za-z0-9_-]{16,}\b/, 'contains an API key'],
  ['stripe key', /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}\b/, 'contains a Stripe key'],
  ['restless key', /\brstlss_[A-Za-z0-9]{16,}\b/, 'contains a Restless write key'],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, 'contains a JWT'],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._-]{20,}/i, 'contains a bearer token'],
  [
    'connection string',
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s/]*:[^\s/]*@/i,
    'contains a connection string with credentials',
  ],
  // An assignment whose value looks like a real secret rather than a
  // placeholder. Naming a variable is fine and often necessary; showing what
  // is in it never is.
  [
    'secret value',
    /\b[A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)S?\s*[=:]\s*["']?(?!(?:your|my|<|\{|\.\.\.|xxx|placeholder|example|changeme|redacted))[A-Za-z0-9_\-/+]{12,}/i,
    'shows the value of a secret environment variable',
  ],

  // --- Real people and accounts. -----------------------------------------
  ['email', /[\w.+-]+@[\w-]+\.[\w.-]+/, 'contains an email address'],
  [
    'uuid',
    /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/,
    'contains a specific ID',
  ],

  // --- Internal infrastructure. ------------------------------------------
  [
    'internal host',
    /\b[\w-]+\.(?:internal|local|localdomain|corp|intranet|lan|test)\b/i,
    'names an internal hostname',
  ],
  [
    'private ip',
    /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/,
    'names a private IP address',
  ],
  ['localhost url', /\bhttps?:\/\/(?:localhost|127\.0\.0\.1)\b/i, 'points at localhost'],
  [
    'non-prod host',
    /\bhttps?:\/\/(?:[\w-]+\.)*(?:staging|stage|dev|qa|preview|internal|admin)\.[\w-]+\.\w+/i,
    'points at a non-production or internal host',
  ],

  // --- Work in progress, and things said out loud in code. ----------------
  ['code marker', /\b(?:TODO|FIXME|HACK|XXX|WIP)\b[:(\s]/, 'quotes a TODO/FIXME comment'],
  [
    'feature flag',
    /\b(?:feature[- ]?flag|behind a flag|flag(?:ged)?[- ]off|kill[- ]?switch|LaunchDarkly|Statsig|Optimizely)\b/i,
    'describes a feature flag',
  ],
  [
    'unreleased',
    /\b(?:not yet (?:released|launched|public|shipped|live)|unreleased|un-?launched|coming soon|in development|pre-?release|upcoming release)\b/i,
    'describes unreleased functionality',
  ],
  [
    'restricted',
    /\b(?:internal[- ]only|staff[- ]only|admin[- ]only|employees? only|for internal use|do not (?:use|ship|document|expose)|not for (?:public|external))\b/i,
    'describes something marked internal or restricted',
  ],
  [
    'disparaging',
    /\b(?:this is broken|known bug|doesn'?t (?:actually )?work|is a hack|temporary workaround|security (?:hole|issue|vulnerability|flaw))\b/i,
    'describes a known bug, hack, or weakness',
  ],
  [
    'ticket',
    /\b(?:[A-Z]{2,10}-\d{1,6})\b(?!\s*(?:error|status|code))/,
    'references an internal ticket',
  ],
];

/** Check every uploaded text field, including member-visible provenance. */
export function inspectCandidate(candidate) {
  const text = [
    candidate?.title,
    candidate?.content,
    candidate?.description,
    candidate?.docsBody,
    candidate?.endpoint,
    candidate?.icon,
    ...(Array.isArray(candidate?.files) ? candidate.files : []),
  ]
    .filter((s) => typeof s === 'string' && s)
    .join('\n').normalize('NFKC').replace(/[\u200b-\u200f\u2060\ufeff]/g, '');

  if (!text.trim()) return { safe: false, reasons: ['is empty'] };

  const reasons = [];
  let decoded = text;
  try { decoded += `\n${decodeURIComponent(text)}`; } catch {}
  decoded += `\n${text.replace(/[A-Za-z0-9+/]{24,}={0,2}/g, (s) => Buffer.from(s, 'base64').toString('utf8'))}`;
  for (const [, re, why] of RULES) {
    if (re.test(decoded)) reasons.push(why);
  }
  return reasons.length ? { safe: false, reasons } : { safe: true };
}

export function contextModels(provider, env = process.env) {
  const extraction = env.RESTLESS_CONTEXT_EXTRACTION_MODEL;
  const review = env.RESTLESS_CONTEXT_REVIEW_MODEL;
  const supported = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];
  if (provider !== 'claude' || !supported.includes(extraction) || !supported.includes(review) || extraction === review) {
    throw new Error('Context requires Claude with distinct explicit RESTLESS_CONTEXT_EXTRACTION_MODEL and RESTLESS_CONTEXT_REVIEW_MODEL identities.');
  }
  return { extraction, review };
}

/**
 * Split a batch into what may be sent and what may not.
 *
 * `withheld` carries the TITLE and the reasons, never the offending body: it
 * exists to be printed on the developer's own terminal so they can see the
 * pass working and go fix the source, and there is no reason for the text to
 * travel any further than it already has.
 */
export function screenCandidates(candidates) {
  const safe = [];
  const withheld = [];
  for (const candidate of candidates) {
    const verdict = inspectCandidate(candidate);
    if (verdict.safe) safe.push(candidate);
    else withheld.push({ title: candidate?.title || '(untitled)', reasons: verdict.reasons });
  }
  return { safe, withheld };
}
