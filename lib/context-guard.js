/**
 * The rules that don't depend on a model behaving.
 *
 * `context` runs three checks before a candidate can reach the inbox, and this
 * is the middle one:
 *
 *   1. the extraction pass, on this machine, told to write only public docs;
 *   2. a redaction pass - an independent model call that sees ONLY the
 *      extracted text, plus this module;
 *   3. the server's knowledge guard: it sanitizes again, then two validators on
 *      two different models must both approve.
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

/** Rules that need more than a regex expose `.test()`, so RULES can treat them alike. */
function matcher(re, accept) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  return {
    test(text) {
      g.lastIndex = 0;
      for (const m of text.matchAll(g)) if (accept(m[0])) return true;
      return false;
    },
  };
}

function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function bitsPerChar(s) {
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) || 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
  return bits;
}

const CARD = matcher(/\b\d(?:[ -]?\d){12,18}\b/, (m) => luhnValid(m.replace(/\D/g, '')));
const PHONE = matcher(
  /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}[\s.-]\d{3,4}(?:[\s.-]?\d{3,4})?\b/,
  (m) => {
    const n = m.replace(/\D/g, '').length;
    return n >= 10 && n <= 15 && !/^\d{4}-\d{2}-\d{2}/.test(m.trim());
  },
);
// Code names match a naming grammar (snake/SCREAMING with separators, or camelCase whose later
// words start uppercase), each word with at most a 3-digit suffix (OAUTH2, Sha256, V2).
const ACRO = String.raw`[A-Z]{2,}(?=[A-Z][a-z]|\d|$)|[A-Z](?=\d)`;
const CAMEL = new RegExp(
  String.raw`^(?:[a-z]+|[A-Z][a-z]+|${ACRO})\d{0,3}(?:(?:[A-Z][a-z]+|${ACRO})\d{0,3})+$`,
);
const SEGMENT = String.raw`(?:[a-z]+|[A-Z][a-z]*|[A-Z]+)\d{0,3}`;
const SNAKE = new RegExp(String.raw`^${SEGMENT}(?:[_-](?:${SEGMENT}|\d{1,3}))+$`);

// Random keys fail the grammar or the word checks below; measured false passes are about 0.2% at 24
// characters and under 0.03% from 40, and the server's two model checks read every upload again.
function looksLikeIdentifier(s) {
  if (!SNAKE.test(s) && !(CAMEL.test(s) && /[a-z]/.test(s))) return false;
  const words = s.match(/[A-Z]{2,}(?=[A-Z][a-z]|\d|_|-|$)|[A-Z]?[a-z]+|[A-Z]+/g) || [];
  if (words.length < 2) return false;
  const letters = words.join('');
  if (letters.length / words.length < 3) return false;
  const vowels = (letters.match(/[aeiouy]/gi) || []).length;
  if (vowels / letters.length < 0.25) return false;
  return words.every((w) => w.length < 5 || /[aeiouy]/i.test(w));
}

// Long, mixed letters and digits, high entropy: a key or hash, not a word or identifier.
const HIGH_ENTROPY = matcher(
  /[A-Za-z0-9+_=-]{24,}/,
  (m) =>
    /\d/.test(m) &&
    /[A-Za-z]/.test(m) &&
    !looksLikeIdentifier(m) &&
    bitsPerChar(m) >= (m.length >= 40 ? 3.6 : 4.0),
);

/**
 * Each rule is [name, regex, why]. Ordered roughly by how bad it would be.
 *
 * These are deliberately blunt. A false positive costs one withheld sentence,
 * which the developer sees named in the summary and can re-word; a false
 * negative is on the public internet.
 */
// Secrets, people and infrastructure: also re-checked on decoded base64/hex/percent runs.
const SENSITIVE_RULES = [
  // --- Credentials. Non-negotiable. ---------------------------------------
  ['private key', /-----BEGIN[A-Z ]*PRIVATE KEY-----/, 'contains a private key block'],
  ['aws key', /\bAKIA[0-9A-Z]{16}\b/, 'contains what looks like an AWS access key'],
  ['github token', /\bgh[pousr]_[A-Za-z0-9]{16,}\b/, 'contains a GitHub token'],
  ['slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, 'contains a Slack token'],
  ['openai key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/, 'contains an API key'],
  ['google key', /\bAIza[0-9A-Za-z_-]{35}\b/, 'contains a Google API key'],
  ['gitlab token', /\bglpat-[A-Za-z0-9_-]{20,}\b/, 'contains a GitLab token'],
  ['github pat', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/, 'contains a GitHub token'],
  ['npm token', /\bnpm_[A-Za-z0-9]{30,}\b/, 'contains an npm token'],
  ['sendgrid key', /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/, 'contains a SendGrid key'],
  ['webhook secret', /\bwhsec_[A-Za-z0-9]{16,}\b/, 'contains a webhook signing secret'],
  ['stripe key', /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}\b/, 'contains a Stripe key'],
  ['restless key', /\brstlss_[A-Za-z0-9]{16,}\b/, 'contains a Restless write key'],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, 'contains a JWT'],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._-]{20,}/i, 'contains a bearer token'],
  [
    'connection string',
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^\s/]*:[^\s/]*@/i,
    'contains a connection string with credentials',
  ],
  [
    'url credentials',
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'`<>]+:[^\s/@"'`<>]+@/i,
    'contains a URL with credentials in it',
  ],
  ['high-entropy token', HIGH_ENTROPY, 'contains what looks like a key or hash'],
  // An assignment whose value looks like a real secret rather than a
  // placeholder. Naming a variable is fine and often necessary; showing what
  // is in it never is.
  [
    'secret value',
    /\b[A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)S?\s*[=:]\s*["']?(?!(?:your|my|<|\{|\.\.\.|xxx|placeholder|example|changeme|redacted))[A-Za-z0-9_\-/+]{12,}/i,
    'shows the value of a secret environment variable',
  ],

  // --- Real people and accounts. -----------------------------------------
  // RFC 2606 example domains are the documented way to show an address, so they pass.
  [
    'email',
    /[\w.+-]+@(?!(?:[\w-]+\.)*(?:example\.(?:com|org|net)|example|invalid)\b(?![.-]))[\w-]+\.[\w.-]+/,
    'contains an email address',
  ],
  [
    'obfuscated email',
    /\b[\w.+-]+\s*(?:\[at\]|\(at\)|\{at\}|\s+at\s+)\s*[\w-]+(?:\s*(?:\[dot\]|\(dot\)|\{dot\}|\s+dot\s+|\.)\s*[\w-]+)*\s*(?:\[dot\]|\(dot\)|\{dot\}|\s+dot\s+)\s*[a-z]{2,24}\b/i,
    'contains an email address',
  ],
  ['phone number', PHONE, 'contains a phone number'],
  ['ssn', /\b\d{3}-\d{2}-\d{4}\b/, 'contains a national ID number'],
  ['card number', CARD, 'contains a payment card number'],
  ['iban', /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b/, 'contains a bank account number'],
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

];

// Prose markers only mean something in plain text, so they are not re-run on decoded runs.
const PROSE_RULES = [
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

const RULES = [...SENSITIVE_RULES, ...PROSE_RULES];

/**
 * Check one candidate's user-visible text.
 *
 * Only the fields that can end up on the docs are checked. File paths are NOT:
 * they are provenance shown to a project member in the dashboard, they never
 * reach the public docs, and a repo full of `src/internal/*` would otherwise
 * fail every rule for no gain.
 *
 * Returns `{ safe: true }` or `{ safe: false, reasons: [...] }`.
 */
export function inspectCandidate(candidate) {
  const text = normalize(
    [candidate?.title, candidate?.content, candidate?.description, candidate?.docsBody]
      .filter((s) => typeof s === 'string' && s)
      .join('\n'),
  );

  if (!text.trim()) return { safe: false, reasons: ['is empty'] };

  const reasons = [];
  for (const [, re, why] of RULES) {
    if (re.test(text) && !reasons.includes(why)) reasons.push(why);
  }
  if (hidesEncodedSecret(text)) reasons.push('hides a secret or personal detail in an encoded string');
  return reasons.length ? { safe: false, reasons } : { safe: true };
}

const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Full-width look-alikes fold to ASCII and zero-width characters vanish, so splitting a key can't dodge a rule. */
function normalize(text) {
  return text.normalize('NFKC').replace(INVISIBLE, '');
}

const ENCODED_RUN = /(?:[^\s%]*%[0-9a-fA-F]{2}[^\s]*|[A-Za-z0-9+/]{16,}={0,2}|[A-Za-z0-9_-]{16,}|(?:[0-9a-fA-F]{2}){10,})/g;

function decodings(run) {
  const out = [];
  const printable = (s) => s.length > 0 && /^[\x20-\x7E\s]+$/.test(s);
  if (/^(?:[0-9a-fA-F]{2})+$/.test(run)) {
    const s = Buffer.from(run, 'hex').toString('utf8');
    if (printable(s)) out.push(s);
  }
  if (run.includes('%')) {
    try {
      out.push(decodeURIComponent(run));
    } catch {
      // Malformed escapes: nothing to scan.
    }
  }
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(run)) {
    const s = Buffer.from(run.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    if (printable(s)) out.push(s);
  }
  return out;
}

/** Base64, hex or percent-encoding is still a leak once anyone decodes it. */
function hidesEncodedSecret(text) {
  for (const [run] of text.matchAll(ENCODED_RUN)) {
    for (const decoded of decodings(run)) {
      if (SENSITIVE_RULES.some(([, re]) => re.test(decoded))) return true;
    }
  }
  return false;
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
