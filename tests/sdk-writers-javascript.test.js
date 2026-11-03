import { describe, it, expect } from 'vitest';
import {
  generate, parse, readBlockFields, canonicalizeInitArg, setOwnerId, stripOwnerIdConfirm,
  hasInit, hasSdkReference, findOldApiSetup, hasWithRestless, hasDefineConfig,
} from '../lib/sdk-writers/javascript.js';

function ctxWith(overrides = {}) {
  return {
    keyDelivery: null,
    apiKey: null,
    envLoader: { mode: 'none', evidence: 'none' },
    ...overrides,
  };
}

describe('generate', () => {
  it('emits a no-arg CJS init when no env loader is present, with no sentinel comments', () => {
    const out = generate(ctxWith({ keyDelivery: 'manual' }), {
      module: 'cjs', framework: 'express', appVar: 'app',
      credentialExpr: 'req.headers.authorization', ownerIdExpr: null,
    });
    expect(out).toContain("const sdk = require('@restlessai/sdk')();");
    expect(out).toContain('app.use(sdk.setup(');
    expect(out).toContain('sdk.mask(req.headers.authorization)');
    expect(out).not.toContain('restless-sdk-start');
    expect(out).not.toContain('restless-sdk-end');
    expect(out).not.toContain('managed by');
  });

  it('uses process.env.RESTLESS_KEY when an env loader is detected', () => {
    const out = generate(
      ctxWith({ keyDelivery: 'env', envLoader: { mode: 'dotenv', evidence: 'dotenv installed' } }),
      { module: 'cjs', framework: 'express', appVar: 'app', credentialExpr: 'req.headers["x-api-key"]' },
    );
    expect(out).toContain('require(\'@restlessai/sdk\')(process.env.RESTLESS_KEY)');
  });

  it('inlines the literal key when keyDelivery is inline, with a TODO comment', () => {
    const out = generate(
      ctxWith({ keyDelivery: 'inline', apiKey: 'rdme_abc' }),
      { module: 'cjs', framework: 'express', appVar: 'app', credentialExpr: 'auth' },
    );
    expect(out).toContain('TODO: move this out of the codebase before committing');
    expect(out).toContain("require('@restlessai/sdk')(\"rdme_abc\")");
  });

  it('emits ESM imports when module is esm', () => {
    const out = generate(ctxWith({ keyDelivery: 'manual' }), {
      module: 'esm', framework: 'express', appVar: 'app', credentialExpr: 'auth',
    });
    expect(out).toContain("import restless from '@restlessai/sdk';");
    expect(out).toContain('const sdk = restless();');
  });

  it('uses fastify.register for fastify framework', () => {
    const out = generate(ctxWith({ keyDelivery: 'manual' }), {
      module: 'cjs', framework: 'fastify', appVar: 'fastify', credentialExpr: 'auth',
    });
    expect(out).toContain('fastify.register(sdk.setup(');
  });

  it('includes owner.id when an expression is provided', () => {
    const out = generate(ctxWith({ keyDelivery: 'manual' }), {
      module: 'cjs', framework: 'express', appVar: 'app', credentialExpr: 'auth',
      ownerIdExpr: 'user.workspaceId',
    });
    expect(out).toContain('owner: { id: user.workspaceId }');
  });

  it('omits the owner block when no ownerIdExpr is provided', () => {
    const out = generate(ctxWith({ keyDelivery: 'manual' }), {
      module: 'cjs', framework: 'express', appVar: 'app', credentialExpr: 'auth',
    });
    expect(out).not.toContain('owner: {');
    // Sanity check: no stale `project: {` either - the legacy shape is read,
    // not written.
    expect(out).not.toContain('project: {');
  });
});

describe('parse', () => {
  it('returns a wrapper when the file references @restlessai/sdk', () => {
    const content = "const sdk = require('@restlessai/sdk')();\napp.use(sdk.setup(req => ({ apiKey: sdk.mask(req.headers.authorization) })));\n";
    const found = parse(content);
    expect(found).not.toBeNull();
    expect(found.block).toBe(content);
    expect(found.startIdx).toBe(0);
    expect(found.endIdx).toBe(content.length);
  });

  it('returns null when the file has no SDK reference', () => {
    expect(parse('const x = 1;\n')).toBeNull();
    expect(parse('')).toBeNull();
    expect(parse(null)).toBeNull();
  });
});

describe('readBlockFields', () => {
  it('reads a literal key out of a CJS init line', () => {
    const content = `const sdk = require('@restlessai/sdk')("rdme_abc");\n`;
    const r = readBlockFields(content);
    expect(r.initArgForm).toBe('literal');
    expect(r.initArgValue).toBe('rdme_abc');
  });

  it('reads an env-ref init line', () => {
    const content = `const sdk = require('@restlessai/sdk')(process.env.RESTLESS_KEY);\n`;
    const r = readBlockFields(content);
    expect(r.initArgForm).toBe('env-ref');
    expect(r.initArgValue).toBe('RESTLESS_KEY');
  });

  it('reads a no-arg init line', () => {
    const content = `const sdk = require('@restlessai/sdk')();\n`;
    const r = readBlockFields(content);
    expect(r.initArgForm).toBe('no-arg');
  });

  it('extracts the credential expression and owner.id expression', () => {
    const content = `const sdk = require('@restlessai/sdk')();
app.use(sdk.setup((req) => ({
  apiKey: sdk.mask(req.headers['x-api-key']),
  owner: { id: workspace.id },
})));`;
    const r = readBlockFields(content);
    expect(r.credentialExpr).toBe("req.headers['x-api-key']");
    expect(r.ownerIdExpr).toBe('workspace.id');
  });

  // Regression: the credential reader used to hardcode the client name
  // (`sdk` or `restless`). An AI install pass on an ESM project named the
  // client `restlessSDK` to avoid shadowing the `import restless` factory,
  // and a correctly-wired block got reported as "credential missing".
  // The reader now accepts any identifier before `.mask(`.
  it.each([
    ['restlessSDK', 'restlessSDK.mask(apiKey)'],
    ['client', 'client.mask(apiKey)'],
    ['sdk', 'sdk.mask(apiKey)'],
    ['restless', 'restless.mask(apiKey)'],
    ['_sdk$', '_sdk$.mask(apiKey)'],
  ])('reads the credential when the client binding is named %s', (clientName, maskCall) => {
    const content = `import restless from '@restlessai/sdk';
const ${clientName} = restless();
fastify.register(${clientName}.setup((req) => ({
  apiKey: ${maskCall},
  owner: { id: String(project._id) },
})));`;
    expect(readBlockFields(content).credentialExpr).toBe('apiKey');
  });

  it('returns ownerIdConfirmReason when the CONFIRM marker is present', () => {
    const content = `const sdk = require('@restlessai/sdk')();
app.use(sdk.setup((req) => ({
  apiKey: sdk.mask(auth),
  // RESTLESS_OWNER_ID_CONFIRM: user.id is a JSON file key that looks like a Mongo ObjectId; no schema to confirm.
  owner: { id: user.id },
})));`;
    const r = readBlockFields(content);
    expect(r.ownerIdExpr).toBe('user.id');
    expect(r.ownerIdConfirmReason).toMatch(/JSON file key/);
  });

  it('returns null ownerIdConfirmReason when the marker is missing', () => {
    const content = `const sdk = require('@restlessai/sdk')();
app.use(sdk.setup((req) => ({
  apiKey: sdk.mask(auth),
  owner: { id: user.id },
})));`;
    expect(readBlockFields(content).ownerIdConfirmReason).toBeNull();
  });

  it('also picks up CONFIRM markers preceding legacy `project: { id }`', () => {
    const content = `const sdk = require('@restlessai/sdk')();
app.use(sdk.setup((req) => ({
  apiKey: sdk.mask(auth),
  // RESTLESS_OWNER_ID_CONFIRM: legacy block.
  project: { id: user.id },
})));`;
    expect(readBlockFields(content).ownerIdConfirmReason).toBe('legacy block.');
  });

  it("extracts owner.id from a ternary `owner: user ? { id: ... } : { id: ... }` (test-api pattern)", () => {
    const content = `const sdk = require('@restlessai/sdk')();
app.use(sdk.setup((req) => {
  const user = lookup(req);
  return {
    apiKey: sdk.mask(key),
    owner: user
      ? { id: user.id, label: user.data.label, email: user.data.email }
      : { id: 'anonymous' },
  };
}));`;
    const r = readBlockFields(content);
    // Picks the truthy-branch id (textually first).
    expect(r.ownerIdExpr).toBe('user.id');
  });

  it('extracts owner.id from `owner: cond && { id: ... }`', () => {
    const content = `const sdk = require('@restlessai/sdk')();
app.use(sdk.setup((req) => ({
  apiKey: sdk.mask(auth),
  owner: req.user && { id: req.user.workspaceId },
})));`;
    expect(readBlockFields(content).ownerIdExpr).toBe('req.user.workspaceId');
  });

  it('reads owner.id from a multi-line block with extra fields between owner and id', () => {
    const content = `const sdk = require('@restlessai/sdk')();
app.use(sdk.setup((req) => ({
  apiKey: sdk.mask(auth),
  owner: {
    label: 'something',
    id: workspace.id,
    email: 'x@y.com',
  },
})));`;
    expect(readBlockFields(content).ownerIdExpr).toBe('workspace.id');
  });

  it('returns null ownerIdExpr when owner is a bare function call (no static id)', () => {
    const content = `const sdk = require('@restlessai/sdk')();
app.use(sdk.setup((req) => ({
  apiKey: sdk.mask(auth),
  owner: buildOwner(req),
})));`;
    expect(readBlockFields(content).ownerIdExpr).toBeNull();
  });

  it('falls back to legacy `project: { id }` when `owner` is absent', () => {
    const content = `const sdk = require('@restlessai/sdk')();
app.use(sdk.setup((req) => ({
  apiKey: sdk.mask(req.headers['x-api-key']),
  project: { id: workspace.id },
})));`;
    const r = readBlockFields(content);
    expect(r.ownerIdExpr).toBe('workspace.id');
  });
});

describe('canonicalizeInitArg', () => {
  // The AI wrote a placeholder; the CLI must replace it deterministically
  // based on ctx.sdkLineSpec. This is the bug-class fix: CLI authoritatively
  // owns the init line, AI's auth/owner work in the callback is preserved.
  const placeholderBlock = `const sdk = require('@restlessai/sdk')(process.env.RESTLESS_KEY);
app.use(sdk.setup((req) => ({
  apiKey: sdk.mask(req.headers['x-api-key']),
  owner: { id: workspace.id },
})));`;

  it('swaps placeholder for the literal key in inline mode', () => {
    const out = canonicalizeInitArg(placeholderBlock, ctxWith({ keyDelivery: 'inline', apiKey: 'rdme_abc' }));
    expect(out).toContain("require('@restlessai/sdk')(\"rdme_abc\")");
    expect(out).toContain('TODO: move this out of the codebase before committing');
    // Auth + owner preserved.
    expect(out).toContain("sdk.mask(req.headers['x-api-key'])");
    expect(out).toContain('owner: { id: workspace.id }');
  });

  it('swaps placeholder for no-arg form when no env loader and not inline', () => {
    const out = canonicalizeInitArg(placeholderBlock, ctxWith({ keyDelivery: 'manual' }));
    expect(out).toContain("require('@restlessai/sdk')()");
    expect(out).not.toContain('process.env.RESTLESS_KEY');
    expect(out).not.toContain('TODO: move this out of the codebase');
  });

  it('keeps process.env.RESTLESS_KEY when env loader is present', () => {
    const out = canonicalizeInitArg(placeholderBlock, ctxWith({ keyDelivery: 'env', envLoader: { mode: 'dotenv', evidence: 'dotenv installed' } }));
    expect(out).toContain('require(\'@restlessai/sdk\')(process.env.RESTLESS_KEY)');
  });

  it('is idempotent - running twice in inline mode produces the same content', () => {
    const ctx = ctxWith({ keyDelivery: 'inline', apiKey: 'rdme_abc' });
    const once = canonicalizeInitArg(placeholderBlock, ctx);
    const twice = canonicalizeInitArg(once, ctx);
    expect(twice).toBe(once);
    // No double-TODO.
    expect(twice.match(/TODO: move this out of the codebase/g)).toHaveLength(1);
  });

  it('strips a stale TODO when switching from inline mode to env mode', () => {
    const inlineBlock = canonicalizeInitArg(placeholderBlock, ctxWith({ keyDelivery: 'inline', apiKey: 'rdme_abc' }));
    const envBlock = canonicalizeInitArg(inlineBlock, ctxWith({ keyDelivery: 'env', envLoader: { mode: 'dotenv', evidence: 'dotenv installed' } }));
    expect(envBlock).not.toContain('TODO: move this out of the codebase');
    expect(envBlock).toContain('process.env.RESTLESS_KEY');
  });

  it('rewrites an ESM init call', () => {
    const esmBlock = `import restless from '@restlessai/sdk';
const sdk = restless(process.env.RESTLESS_KEY);
app.use(sdk.setup((req) => ({ apiKey: sdk.mask(req.headers.authorization) })));`;
    const out = canonicalizeInitArg(esmBlock, ctxWith({ keyDelivery: 'inline', apiKey: 'rdme_abc' }));
    expect(out).toContain('const sdk = restless("rdme_abc");');
  });

  it('returns content unchanged when there is no SDK reference', () => {
    expect(canonicalizeInitArg('const x = 1;\n', ctxWith({ keyDelivery: 'inline', apiKey: 'rdme_abc' })))
      .toBe('const x = 1;\n');
  });
  // RES-22: a pre-wired app with options was rewritten to a bare
  // `require('@restlessai/sdk')()`, silently dropping its sampling rule and
  // custom fetch. Only the key argument is the CLI's; options are the user's.
  describe('keeps options passed after the key', () => {
    const optionsBlock = `const restless = require('@restlessai/sdk')(process.env.RESTLESS_KEY, {
  fetch: instrumentedFetch,
  sampling: { routes: { 'GET /healthz': 'off' } },
});
app.use(restless.setup((req) => ({ apiKey: restless.mask(req.headers['x-api-key']) })));`;
    const options = `{
  fetch: instrumentedFetch,
  sampling: { routes: { 'GET /healthz': 'off' } },
}`;
    const dotenv = { keyDelivery: 'env', envLoader: { mode: 'dotenv', evidence: 'dotenv installed' } };

    it('leaves a multi-line options object alone when the key already matches', () => {
      expect(canonicalizeInitArg(optionsBlock, ctxWith(dotenv))).toBe(optionsBlock);
    });

    it('holds the key slot with undefined in no-arg mode, so options stay second', () => {
      const out = canonicalizeInitArg(optionsBlock, ctxWith({ keyDelivery: 'manual' }));
      expect(out).toContain(`require('@restlessai/sdk')(undefined, ${options});`);
      expect(readBlockFields(out).initArgForm).toBe('no-arg');
      // Settles: a second run is a no-op.
      expect(canonicalizeInitArg(out, ctxWith({ keyDelivery: 'manual' }))).toBe(out);
    });

    it('inlines the key without touching the options', () => {
      const out = canonicalizeInitArg(optionsBlock, ctxWith({ keyDelivery: 'inline', apiKey: 'rdme_abc' }));
      expect(out).toContain(`require('@restlessai/sdk')("rdme_abc", ${options});`);
      expect(readBlockFields(out)).toMatchObject({ initArgForm: 'literal', initArgValue: 'rdme_abc' });
    });

    it('reads an option holding a call whole, instead of cutting at its paren', () => {
      const block = "const sdk = require('@restlessai/sdk')(process.env.RESTLESS_KEY, { fetch: wrap(fetch), sampling: 0.5 });\n";
      expect(canonicalizeInitArg(block, ctxWith({ keyDelivery: 'manual' })))
        .toBe("const sdk = require('@restlessai/sdk')(undefined, { fetch: wrap(fetch), sampling: 0.5 });\n");
    });

    it('keeps options on the ESM form', () => {
      const block = `import restless from '@restlessai/sdk';
const sdk = restless(process.env.RESTLESS_KEY, {
  baseUrl: 'https://example.test',
});`;
      const out = canonicalizeInitArg(block, ctxWith({ keyDelivery: 'inline', apiKey: 'rdme_abc' }));
      expect(out).toContain(`const sdk = restless("rdme_abc", {\n  baseUrl: 'https://example.test',\n});`);
    });

    it('still drops a lone key to a bare call in no-arg mode', () => {
      const out = canonicalizeInitArg(
        "const sdk = require('@restlessai/sdk')(process.env.RESTLESS_KEY);\n",
        ctxWith({ keyDelivery: 'manual' }),
      );
      expect(out).toBe("const sdk = require('@restlessai/sdk')();\n");
    });

    it('ignores commas and parens inside comments and strings', () => {
      const commented = "const sdk = require('@restlessai/sdk')(process.env.RESTLESS_KEY /* env, optional */);\n";
      expect(canonicalizeInitArg(commented, ctxWith({ keyDelivery: 'manual' })))
        .toBe("const sdk = require('@restlessai/sdk')();\n");
      expect(readBlockFields(commented).initArgForm).toBe('env-ref');

      const lineComment = `const sdk = require('@restlessai/sdk')(
  process.env.RESTLESS_KEY, // key, from env (see README)
  { sampling: { routes: { 'GET /x(y), z': 'off' } } },
);`;
      expect(canonicalizeInitArg(lineComment, ctxWith({ keyDelivery: 'manual' }))).toBe(`const sdk = require('@restlessai/sdk')(
  undefined, // key, from env (see README)
  { sampling: { routes: { 'GET /x(y), z': 'off' } } },
);`);
    });

    it('leaves a call whose parens never close alone', () => {
      const block = "const sdk = require('@restlessai/sdk')(process.env.RESTLESS_KEY, {\n";
      expect(canonicalizeInitArg(block, ctxWith({ keyDelivery: 'manual' }))).toBe(block);
    });
  });
});

describe('hasInit', () => {
  it('accepts CJS immediate-call form', () => {
    expect(hasInit(`const sdk = require('@restlessai/sdk')(process.env.RESTLESS_KEY);`)).toBe(true);
    expect(hasInit(`const sdk = require('@restlessai/sdk')();`)).toBe(true);
  });

  it('accepts CJS named form with a later factory call', () => {
    const content = `const restless = require('@restlessai/sdk');
const sdk = restless(process.env.RESTLESS_KEY);
sdk.setup(...);`;
    expect(hasInit(content)).toBe(true);
  });

  it('accepts ESM with a later factory call', () => {
    const content = `import restless from '@restlessai/sdk';
const sdk = restless(process.env.RESTLESS_KEY);`;
    expect(hasInit(content)).toBe(true);
  });

  it("rejects ESM import without a factory call (the OLD-API trap)", () => {
    // `import restless from '@restlessai/sdk'; restless.setup(app, cb);`
    // is what install-sdk used to treat as "wired" - but `restless` is the
    // factory in the new SDK, so `restless.setup` is undefined at runtime.
    // hasInit must say "not wired" so the install pass rewrites it.
    const content = `import restless from '@restlessai/sdk';
restless.setup(app, (req) => ({ apiKey: restless.mask(req.headers.authorization) }));`;
    expect(hasInit(content)).toBe(false);
  });

  it('rejects CJS named import without a factory call', () => {
    const content = `const restless = require('@restlessai/sdk');
restless.setup(app, (req) => ({}));`;
    expect(hasInit(content)).toBe(false);
  });

  it("doesn't false-positive on property access calls (`restless.mask(x)` is not a factory call)", () => {
    const content = `import restless from '@restlessai/sdk';
const masked = restless.mask(req.headers.authorization);`;
    expect(hasInit(content)).toBe(false);
  });

  it('returns false for empty input or a bare quoted mention', () => {
    expect(hasInit('')).toBe(false);
    expect(hasInit(null)).toBe(false);
    expect(hasInit(`// see '@restlessai/sdk' docs`)).toBe(false);
  });
});

describe('@restlessai/sdk/next subpath (Next.js adapter)', () => {
  // The Next.js adapter is imported from the `/next` subpath. Detection must
  // treat it as a real wiring - otherwise a correct Next install is judged
  // "not wired" and the CLI fatals / loops.
  const nextClient = `import restless from '@restlessai/sdk/next';
const client = restless(process.env.RESTLESS_KEY);
export const wrap = client.setup(async (req) => ({ apiKey: client.mask(req.headers.get('authorization')) }));`;

  it('hasInit recognizes the ESM /next factory call', () => {
    expect(hasInit(nextClient)).toBe(true);
  });

  it('hasInit recognizes a CJS /next immediate-call', () => {
    expect(hasInit(`const client = require('@restlessai/sdk/next')(process.env.RESTLESS_KEY);`)).toBe(true);
  });

  it('parse and hasSdkReference match the /next subpath', () => {
    expect(parse(nextClient)).not.toBeNull();
    expect(hasSdkReference(nextClient)).toBe(true);
  });

  it('canonicalizeInitArg rewrites the /next init arg to the env ref', () => {
    const literal = `import restless from '@restlessai/sdk/next';
const client = restless("rstlss_literalkey");
export const wrap = client.setup(async () => ({}));`;
    const out = canonicalizeInitArg(literal, {
      keyDelivery: 'env',
      envLoader: { mode: 'auto', evidence: 'next' },
    });
    expect(out).toContain('const client = restless(process.env.RESTLESS_KEY);');
    expect(out).not.toContain('rstlss_literalkey');
  });

  it('still rejects a bare /next import with no factory call (OLD-API trap)', () => {
    const content = `import restless from '@restlessai/sdk/next';
restless.setup(handler);`;
    expect(hasInit(content)).toBe(false);
  });
});

describe('findOldApiSetup', () => {
  it('finds a 2-arg setup(app, cb) call', () => {
    const content = `import restless from '@restlessai/sdk';
restless.setup(app, (req) => ({ apiKey: restless.mask(req.headers.authorization) }));`;
    expect(findOldApiSetup(content)).toBeGreaterThan(0);
  });

  it('finds a 2-arg setup with multi-line callback', () => {
    const content = `restless.setup(app, (req) => {
  return { apiKey: restless.mask(req.headers.authorization) };
});`;
    expect(findOldApiSetup(content)).toBeGreaterThanOrEqual(0);
  });

  it('returns null for a 1-arg setup(cb), the current API', () => {
    const content = `app.use(sdk.setup((req) => ({ apiKey: sdk.mask(req.headers.authorization) })));`;
    expect(findOldApiSetup(content)).toBeNull();
  });

  it('does not get tripped up by commas inside the callback signature', () => {
    // Two-arg arrow function `(req, res) => ...` is still ONE argument
    // to .setup() because the commas are inside parens at depth >= 2.
    const content = `app.use(sdk.setup((req, res) => ({ apiKey: sdk.mask(req.headers.authorization) })));`;
    expect(findOldApiSetup(content)).toBeNull();
  });

  it('does not get tripped up by commas inside the callback body', () => {
    const content = `app.use(sdk.setup((req) => ({
  apiKey: sdk.mask(req.headers.authorization),
  owner: { id: req.user.id, label: req.user.name },
})));`;
    expect(findOldApiSetup(content)).toBeNull();
  });

  it('handles empty input safely', () => {
    expect(findOldApiSetup('')).toBeNull();
    expect(findOldApiSetup(null)).toBeNull();
  });
});

describe('stripOwnerIdConfirm', () => {
  it('removes the marker comment line, leaving the owner line untouched', () => {
    const before = `const sdk = require('@restlessai/sdk')();
app.use(sdk.setup((req) => ({
  apiKey: sdk.mask(auth),
  // RESTLESS_OWNER_ID_CONFIRM: a reason that spans this line.
  owner: { id: user.id },
})));`;
    const after = stripOwnerIdConfirm(before);
    expect(after).not.toContain('RESTLESS_OWNER_ID_CONFIRM');
    expect(after).toContain('owner: { id: user.id }');
    // Indentation of owner line preserved.
    expect(after).toMatch(/^[ \t]+owner: \{ id: user\.id \},$/m);
  });

  it('is a no-op when the marker is absent', () => {
    const before = `const sdk = require('@restlessai/sdk')();
app.use(sdk.setup((req) => ({
  apiKey: sdk.mask(auth),
  owner: { id: user.id },
})));`;
    expect(stripOwnerIdConfirm(before)).toBe(before);
  });

  it('only strips markers that precede an owner/project line', () => {
    // Stray marker elsewhere shouldn't be deleted by mistake.
    const before = `// RESTLESS_OWNER_ID_CONFIRM: unrelated comment.
const x = 1;`;
    expect(stripOwnerIdConfirm(before)).toBe(before);
  });
});

describe('setOwnerId', () => {
  it('inserts owner.id after apiKey when the block has none', () => {
    const initial = generate(ctxWith({ keyDelivery: 'manual' }), {
      module: 'cjs', framework: 'express', appVar: 'app', credentialExpr: 'auth',
    });
    const content = `const app = require('express')();\n${initial}`;
    const next = setOwnerId(content, 'user.workspaceId');
    expect(next).toContain('owner: { id: user.workspaceId },');
    // apiKey line still present, no duplicate owner lines.
    expect(next.match(/apiKey:\s*sdk\.mask/g)).toHaveLength(1);
    expect(next.match(/owner\s*:\s*\{\s*id:/g)).toHaveLength(1);
  });

  it('replaces an existing risky owner.id in place', () => {
    const initial = generate(ctxWith({ keyDelivery: 'manual' }), {
      module: 'cjs', framework: 'express', appVar: 'app',
      credentialExpr: 'auth', ownerIdExpr: 'req.headers.authorization',
    });
    const content = `const app = require('express')();\n${initial}`;
    const next = setOwnerId(content, 'user.id');
    expect(next).toContain('owner: { id: user.id }');
    expect(next).not.toContain('req.headers.authorization');
  });

  it('upgrades a legacy `project: { id }` to `owner: { id }`', () => {
    const content = `const sdk = require('@restlessai/sdk')();
app.use(sdk.setup((req) => ({
  apiKey: sdk.mask(auth),
  project: { id: req.headers.authorization },
})));`;
    const next = setOwnerId(content, 'user.id');
    expect(next).toContain('owner: { id: user.id }');
    expect(next).not.toContain('project: {');
    expect(next).not.toContain('req.headers.authorization');
  });

  it('preserves the apiKey line indentation when inserting', () => {
    const initial = generate(ctxWith({ keyDelivery: 'manual' }), {
      module: 'cjs', framework: 'express', appVar: 'app', credentialExpr: 'auth',
    });
    const next = setOwnerId(initial, 'user.id');
    // The new owner line should share the same leading whitespace as apiKey.
    const apiKeyIndent = next.match(/^([ \t]*)apiKey\s*:/m)[1];
    const ownerIndent = next.match(/^([ \t]*)owner\s*:/m)[1];
    expect(ownerIndent).toBe(apiKeyIndent);
  });

  it('returns content unchanged when there is no managed block', () => {
    const content = `const x = 1;\n`;
    expect(setOwnerId(content, 'user.id')).toBe(content);
  });

  it('bails when owner is a ternary or other non-`{` expression (would create duplicate keys)', () => {
    const ternary = `const sdk = require('@restlessai/sdk')();
app.use(sdk.setup((req) => ({
  apiKey: sdk.mask(key),
  owner: user ? { id: user.id } : { id: 'anonymous' },
})));`;
    // The repair flow runs setOwnerId, but with a ternary already in place
    // inserting another owner: line would produce two owner properties in
    // the same object literal (syntax error). Safer to leave alone.
    const next = setOwnerId(ternary, 'workspace.id');
    expect(next).toBe(ternary);
    // No new owner line.
    expect((next.match(/\bowner\s*:/g) || []).length).toBe(1);
  });

  it('returns content unchanged when the expression is empty or whitespace', () => {
    const initial = generate(ctxWith({ keyDelivery: 'manual' }), {
      module: 'cjs', framework: 'express', appVar: 'app', credentialExpr: 'auth',
    });
    expect(setOwnerId(initial, '')).toBe(initial);
    expect(setOwnerId(initial, '   ')).toBe(initial);
  });
});


describe('Next.js plugin wiring detection (withRestless / defineConfig)', () => {
  // The single-config integration uses NAMED exports of the /next subpath
  // and has no factory call, so hasInit() must stay blind to it (a plugin
  // file must not be mistaken for a classic wiring) while the dedicated
  // checks see it.
  const WRAPPED_CONFIG = `import { withRestless } from '@restlessai/sdk/next';
const nextConfig = { reactStrictMode: true };
export default withRestless(nextConfig);`;

  const CAPTURE_CONFIG = `import { defineConfig, mask } from '@restlessai/sdk/next';
export default defineConfig({
  setup: async (req) => ({
    apiKey: mask(req.headers.get('authorization')?.slice(7)),
    owner: { id: 'workspace-1', enrich: async () => ({}) },
  }),
});`;

  it('hasWithRestless matches the ESM wrapped config', () => {
    expect(hasWithRestless(WRAPPED_CONFIG)).toBe(true);
  });

  it('hasWithRestless matches the CJS require form', () => {
    expect(hasWithRestless(`const { withRestless } = require('@restlessai/sdk/next');
module.exports = withRestless({});`)).toBe(true);
  });

  it('hasWithRestless follows an import alias', () => {
    expect(hasWithRestless(`import { withRestless as withCapture } from '@restlessai/sdk/next';
export default withCapture({});`)).toBe(true);
  });

  it('hasWithRestless needs the call, not just the import', () => {
    expect(hasWithRestless(`import { withRestless } from '@restlessai/sdk/next';
export default {};`)).toBe(false);
  });

  it('hasWithRestless rejects an import from the bare entry', () => {
    expect(hasWithRestless(`import { withRestless } from '@restlessai/sdk';
export default withRestless({});`)).toBe(false);
  });

  it('hasDefineConfig matches the capture config', () => {
    expect(hasDefineConfig(CAPTURE_CONFIG)).toBe(true);
  });

  it('hasDefineConfig matches a CJS destructured require with alias', () => {
    expect(hasDefineConfig(`const { defineConfig: dc, mask } = require('@restlessai/sdk/next');
module.exports = dc({ setup: async () => ({ apiKey: mask(null) }) });`)).toBe(true);
  });

  it('hasDefineConfig needs the call, not just the import', () => {
    expect(hasDefineConfig(`import { defineConfig } from '@restlessai/sdk/next';`)).toBe(false);
  });

  it('both return false on empty input', () => {
    expect(hasWithRestless('')).toBe(false);
    expect(hasDefineConfig(null)).toBe(false);
  });

  it('plugin files stay invisible to hasInit (no factory call)', () => {
    expect(hasInit(WRAPPED_CONFIG)).toBe(false);
    expect(hasInit(CAPTURE_CONFIG)).toBe(false);
  });

  it('readBlockFields reads the bare mask(...) credential and owner.id from a capture config', () => {
    const fields = readBlockFields(CAPTURE_CONFIG);
    expect(fields.credentialExpr).toBe("req.headers.get('authorization')?.slice(7)");
    expect(fields.ownerIdExpr).toBe("'workspace-1'");
  });

  it('setOwnerId patches the owner inside a defineConfig block', () => {
    const out = setOwnerId(CAPTURE_CONFIG, 'session.workspaceId');
    expect(out).toContain('owner: { id: session.workspaceId, enrich: async () => ({}) }');
  });
});
