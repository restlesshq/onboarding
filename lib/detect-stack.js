import fs from 'fs';
import path from 'path';
import { IGNORE_DIRS, isFrameworkDep, scanCodebase } from './find-endpoints.js';
import * as timings from './timings.js';
import {
  SUPPORTED_LANGUAGES,
  SUPPORTED_LANGUAGES_LABEL,
  describeLanguages,
  getSdkWriter,
  normalizeLanguage,
} from './sdk-writers/index.js';

/**
 * Deterministic "what is this repo written in?" pass, run BEFORE any LLM call.
 *
 * Two jobs, in this order:
 *
 *   1. ROUTE. Decide which deterministic scanners to run (`lib/scanners.js`)
 *      and, through them, which SDK writer, guide and install command each
 *      detected API ends up with.
 *   2. STOP, but only for a language we have no writer for at all. PHP, Rust,
 *      Java and the rest still exit here with a real message rather than
 *      falling into the picker, whose only option is a free-form hint that
 *      re-runs the same scan - a user could answer "it's a Laravel API in
 *      backend/" and loop forever. Which languages those are is not written
 *      down here: `isSupportedLanguage` asks the writer registry, so adding a
 *      writer moves a language out of this branch on its own.
 *
 * It began as job 2 alone, when JavaScript was the only dialect. The guard
 * before that lived in `prompts/detect-endpoints.md` ("zero endpoints AND no
 * package.json -> return []") and missed the common shape: a Django or Rails
 * backend with a React frontend HAS a `package.json`, so the bail never fired
 * and the LLM would label the frontend as the API.
 *
 * ## Which way this errs
 *
 * Returning too many languages costs one extra tree walk and contributes
 * nothing to the findings when a scanner comes back empty. Returning too few
 * silently hides an entire API. So evidence is read generously - a manifest
 * OR the language's source extension is enough - and more than one language
 * is a normal answer, not a conflict to resolve. A Django API behind a
 * Next.js frontend is two real APIs, and the picker already exists to let the
 * user choose.
 *
 * Stopping stays conservative for the same reason it always was: it requires
 * zero evidence of ANY language we can set up, plus at least one foreign
 * manifest. A Node API with a `requirements.txt` for a build script keeps
 * working, and so does an empty repo - `supported` stays true there, and
 * `foundCode` is what tells it apart.
 */

// Base skip list shared with the endpoint scan, plus the foreign-ecosystem
// vendor dirs it never had a reason to name. These matter here specifically:
// `.venv/**/pyproject.toml` and `vendor/bundle/**/Gemfile` are manifests
// belonging to installed dependencies, and counting them would report a Node
// repo as Python for having a virtualenv checked in.
const SKIP_DIRS = new Set([
  ...IGNORE_DIRS,
  '.venv',
  'venv',
  'env',
  'virtualenv',
  '__pycache__',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  'vendor',
  'target',
  '.gradle',
  '.bundle',
  'Pods',
  '.terraform',
]);

const MAX_DEPTH = 6;

/**
 * Languages to look for source evidence of, and which extensions prove it.
 *
 * Read off the registry rather than written out as
 * `{ python: '.py', ruby: '.rb', go: '.go' }`, which was a fourth table of
 * "what files mean language X" alongside the descriptors, `FOREIGN_MANIFESTS`
 * and the scanners - and had already drifted from the descriptors it
 * duplicated. JavaScript is excluded because it is decided by the much richer
 * dependency evidence below, not by spotting a `.js` file.
 */
const SOURCE_EVIDENCE_LANGUAGES = SUPPORTED_LANGUAGES
  .filter((language) => language !== 'javascript' && language !== 'typescript')
  .map((language) => ({ language, extensions: getSdkWriter(language).descriptor.extensions }));

const MAX_SOURCE_BYTES = 512 * 1024;

// Manifests that mean "another language's toolchain builds something here".
// Matched by exact filename, or by extension where the name is project-chosen
// (`.csproj` and friends).
const FOREIGN_MANIFESTS = [
  { file: 'requirements.txt', language: 'Python' },
  { file: 'pyproject.toml', language: 'Python' },
  { file: 'Pipfile', language: 'Python' },
  { file: 'setup.py', language: 'Python' },
  { file: 'manage.py', language: 'Python' },
  { file: 'environment.yml', language: 'Python' },
  { file: 'Gemfile', language: 'Ruby' },
  { file: 'config.ru', language: 'Ruby' },
  { file: 'go.mod', language: 'Go' },
  { file: 'composer.json', language: 'PHP' },
  { file: 'artisan', language: 'PHP' },
  { file: 'Cargo.toml', language: 'Rust' },
  { file: 'pom.xml', language: 'Java' },
  { file: 'build.gradle', language: 'Java' },
  { file: 'build.gradle.kts', language: 'Kotlin' },
  { file: 'mix.exs', language: 'Elixir' },
  { file: 'Package.swift', language: 'Swift' },
  { file: 'pubspec.yaml', language: 'Dart' },
  { ext: '.csproj', language: '.NET' },
  { ext: '.fsproj', language: '.NET' },
  { ext: '.sln', language: '.NET' },
];

// Dependencies that mean Node is serving HTTP here.
//
// MUCH wider than `isFrameworkDep` in find-endpoints.js on purpose: that list
// decides which wiring guide to use, this one decides whether to block. Meta
// frameworks (Next, Nuxt, SvelteKit, Remix, Astro) count because they own API
// routes, and Next is a first-class supported target.
const NODE_SERVER_DEP_PATTERNS = [
  /^(express|fastify|koa|hono|next|nuxt|restify|connect|hapi|polka|micro|h3|elysia|srvx|nitropack)$/,
  /^(sails|feathers|adonis|loopback|marble|tinyhttp|find-my-way|router|body-parser)$/,
  /^(graphql-yoga|apollo-server|apollo-server-express|mercurius|type-graphql)$/,
  /^(socket\.io|ws|uWebSockets\.js)$/,
  /^@(fastify|koa|nestjs|hapi|trpc|apollo|remix-run|sveltejs|adonisjs|feathersjs|tanstack)\//,
  /^(fastify|koa|express)-/,
  /^(astro|@astrojs\/node|remix|@remix-run\/node)$/,
  /^(serverless-http|aws-serverless-express|@vendia\/serverless-express)$/,
];

function isNodeServerDep(name) {
  if (isFrameworkDep(name)) return true;
  return NODE_SERVER_DEP_PATTERNS.some((re) => re.test(name));
}

// Source-level evidence of a Node HTTP server that declares no dependency we
// recognize: the built-in `http`/`https` modules, and Deno/Bun-style
// `serve()`. Only consulted on the path where we are otherwise about to
// block, so the cost is paid once and never on a normal run.
const NODE_SERVER_MARKERS = [
  /\bcreateServer\s*\(/,
  /\bfrom\s+['"]node:https?['"]/,
  /\bfrom\s+['"]node:http2['"]/,
  /require\s*\(\s*['"](?:node:)?https?['"]\s*\)/,
  /require\s*\(\s*['"](?:node:)?http2['"]\s*\)/,
  /\bBun\.serve\s*\(/,
  /\bDeno\.serve\s*\(/,
  /\bexport\s+default\s*\{[^}]*\bfetch\b/,
  /\.listen\s*\(\s*(?:process\.env\.PORT|PORT|port|\d{2,5})/,
];

const SOURCE_EXTS = new Set(['.js', '.ts', '.mjs', '.cjs', '.tsx', '.jsx']);

// Evidence that this repo is a documentation SITE rather than the server it
// documents. Counted only after every server signal above has come back
// empty, so a Docusaurus site that also runs an Express API, or a Next.js
// app with API routes that happens to render MDX, is never affected - those
// repos carry server evidence and this table is never consulted.
//
// Deliberately NOT a count of JavaScript files: a docs site built with
// Docusaurus has plenty of JS, and a small API has very little. The signal
// is "a static-site generator or docs platform is the thing package.json
// installs", plus the shape of the tree (many Markdown pages, little source).
const DOCS_SITE_DEP_PATTERNS = [
  /^(docusaurus|@docusaurus\/.+)$/,
  /^(vitepress|vuepress|@vuepress\/.+)$/,
  /^(nextra|nextra-theme-docs)$/,
  /^@astrojs\/starlight$/,
  /^(mintlify|mint)$/,
  /^(gitbook|gitbook-cli)$/,
  /^(docsify|docsify-cli|@docsify\/.+)$/,
  /^(@redocly\/cli|redoc-cli)$/,
  /^(rdme|@readme\/rdme)$/,
  /^(honkit|mdbook)$/,
];

// Config files that only a docs generator writes. The walker skips dot
// directories, so `.vitepress/` and `.vuepress/` are checked by name as
// directories rather than by the config file inside them.
const DOCS_CONFIG_FILES = [
  /^docusaurus\.config\.(js|ts|mjs|cjs)$/,
  /^mkdocs\.ya?ml$/,
  /^mint\.json$/,
  /^redocly\.ya?ml$/,
  /^book\.toml$/,
  /^antora-playbook\.ya?ml$/,
  /^\.?gitbook\.ya?ml$/,
];
const DOCS_CONFIG_DIRS = new Set(['.vitepress', '.vuepress']);

const MARKDOWN_EXTS = new Set(['.md', '.mdx']);
// "Markdown-heavy" means at least this many pages AND more pages than source
// files. The floor keeps a README plus a CHANGELOG from counting.
const MIN_MARKDOWN_PAGES = 10;

/** Which foreign language a filename implies, or null. */
function foreignLanguageFor(name) {
  for (const entry of FOREIGN_MANIFESTS) {
    if (entry.file && entry.file === name) return entry.language;
    if (entry.ext && name.endsWith(entry.ext)) return entry.language;
  }
  return null;
}

/**
 * One shallow walk collecting only what the verdict needs: foreign manifests,
 * `package.json` paths, and Node source paths. Reads no file contents - the
 * `package.json` parse and the marker scan happen after, and the marker scan
 * only when we're about to block.
 */
function walk(dir, rootDir, acc, depth) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (DOCS_CONFIG_DIRS.has(entry.name)) acc.docsConfigs.push(path.relative(rootDir, full) + '/');
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      walk(full, rootDir, acc, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;

    const rel = path.relative(rootDir, full);
    if (entry.name === 'package.json') {
      acc.packageJsons.push({ abs: full, rel });
      continue;
    }
    const language = foreignLanguageFor(entry.name);
    if (language) {
      acc.foreignFiles.push({ rel, language });
      continue;
    }
    if (DOCS_CONFIG_FILES.some((re) => re.test(entry.name))) acc.docsConfigs.push(rel);
    const ext = path.extname(entry.name);
    acc.extCounts[ext] = (acc.extCounts[ext] || 0) + 1;
    if (SOURCE_EXTS.has(ext)) acc.sourceFiles.push(full);
  }
}

/** Docs-generator deps declared across every package.json in the tree. */
function docsDepEvidence(packageJsons) {
  const evidence = [];
  for (const { abs, rel } of packageJsons) {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch {
      continue;
    }
    const deps = Object.keys({
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    });
    const hits = deps.filter((d) => DOCS_SITE_DEP_PATTERNS.some((re) => re.test(d))).sort();
    if (hits.length) evidence.push(`${hits.join(', ')} in ${rel}`);
  }
  return evidence;
}

/**
 * Why this tree looks like a docs site: generator deps, generator config,
 * and a Markdown-heavy shape. Each line is human-readable so the stop
 * message can cite it, the same way `nodeEvidence` is cited.
 */
function docsEvidenceFor(acc) {
  const evidence = docsDepEvidence(acc.packageJsons);
  if (acc.docsConfigs.length) evidence.push(`${acc.docsConfigs.slice(0, 3).sort().join(', ')}`);
  const pages = [...MARKDOWN_EXTS].reduce((n, ext) => n + (acc.extCounts[ext] || 0), 0);
  const source = [...SOURCE_EXTS].reduce((n, ext) => n + (acc.extCounts[ext] || 0), 0);
  if (pages >= MIN_MARKDOWN_PAGES && pages > source) {
    evidence.push(`${pages} Markdown pages, ${source} source file${source === 1 ? '' : 's'}`);
  }
  return evidence;
}

/** Node server deps declared across every package.json in the tree. */
function nodeDepEvidence(packageJsons) {
  const evidence = [];
  for (const { abs, rel } of packageJsons) {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch {
      // An unreadable/invalid package.json is still a Node signal in itself,
      // but a weak one - a broken manifest shouldn't decide the verdict.
      continue;
    }
    const deps = Object.keys({
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
      ...(pkg.peerDependencies || {}),
      ...(pkg.optionalDependencies || {}),
    });
    const hits = deps.filter(isNodeServerDep).sort();
    if (hits.length) evidence.push(`${hits.join(', ')} in ${rel}`);
  }
  return evidence;
}

/**
 * Last-chance scan for a Node server with no recognizable dependency, e.g. a
 * bare `node:http` service or a framework newer than our lists. Runs only when
 * every cheaper signal came back empty and a foreign manifest is present, so
 * the one repo shape that pays for this scan is the one about to be blocked.
 */
function nodeSourceEvidence(sourceFiles) {
  for (const file of sourceFiles) {
    let content;
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_SOURCE_BYTES) continue;
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const marker = NODE_SERVER_MARKERS.find((re) => re.test(content));
    if (marker) return `Node server code in ${file}`;
  }
  return null;
}

/**
 * Classify a repo as something we can set up or not.
 *
 * Returns:
 *   {
 *     supported,      // false only when we're confident there's no Node here
 *     nodeEvidence,   // why we think it IS Node (empty when unsupported)
 *     docsEvidence,   // why it looks like a docs site (only when nodeEvidence is empty)
 *     likelyDocs,     // docs evidence with no server evidence of any kind
 *     foreign: [{ language, files: string[] }],  // strongest first
 *     languages,      // foreign language names, most-evidence-first
 *   }
 */
export function detectStack(rootDir) {
  const endWalkSpan = timings.start('walk: detect-stack', { kind: timings.KINDS.SCAN });
  const acc = { packageJsons: [], foreignFiles: [], sourceFiles: [], docsConfigs: [], extCounts: {} };
  walk(rootDir, rootDir, acc, 0);
  endWalkSpan({ files: acc.sourceFiles.length, manifests: acc.packageJsons.length });

  // Group foreign manifests by language, most evidence first, so the message
  // leads with the language the repo is actually written in rather than
  // whichever manifest the walk happened to reach first.
  const byLanguage = new Map();
  for (const { rel, language } of acc.foreignFiles) {
    if (!byLanguage.has(language)) byLanguage.set(language, []);
    byLanguage.get(language).push(rel);
  }
  const foreign = [...byLanguage.entries()]
    .map(([language, files]) => ({ language, files: files.sort() }))
    .sort((a, b) => b.files.length - a.files.length || a.language.localeCompare(b.language));

  const nodeEvidence = nodeDepEvidence(acc.packageJsons);

  // Only worth computing when no server dep was declared: a docs site that
  // also serves an API is an API repo, and the list below never gets cited.
  const docsEvidence = nodeEvidence.length === 0 ? docsEvidenceFor(acc) : [];

  // The last-chance source scan runs on the two shapes we are about to stop
  // for - a foreign manifest, or a docs-shaped tree - so a bare `node:http`
  // server inside either still counts as Node.
  if (nodeEvidence.length === 0 && (foreign.length > 0 || docsEvidence.length > 0)) {
    // Routes our regex can see are proof of a Node server whatever the deps say.
    let scan;
    try {
      scan = scanCodebase(rootDir);
    } catch {
      scan = { endpoints: [], frameworkSignals: [] };
    }
    if (scan.endpoints.length > 0) {
      nodeEvidence.push(`${scan.endpoints.length} Node route(s) matched in source`);
    } else if (scan.frameworkSignals.length > 0) {
      nodeEvidence.push('Node framework signals in source');
    } else {
      const marker = nodeSourceEvidence(acc.sourceFiles);
      if (marker) nodeEvidence.push(marker);
    }
  }

  // Which languages this repo should actually be SCANNED as, strongest
  // evidence first. More than one is normal and not a problem: a Django API
  // behind a Next.js frontend is two real APIs, and the picker is already
  // built to let the user choose between them. Each scanner returns the same
  // shape, so the findings merge and every detected API carries its own
  // language through to install.
  const setupLanguages = [];
  // Node, on server evidence or simply because no foreign manifest suggests
  // otherwise - the long-standing "stay out of the way" default.
  if (nodeEvidence.length > 0 || foreign.length === 0) setupLanguages.push('javascript');

  // Every other supported language, on a manifest OR its source extension.
  // The manifest alone is not enough: `test-apis/python` carries no
  // requirements.txt because its fixtures load the SDK by relative path, and
  // plenty of real services keep dependencies somewhere this walk cannot see
  // (a parent image, a lockfile-only layout). Over-scanning is cheap - a
  // scanner that finds nothing contributes nothing to the findings - while
  // under-scanning silently hides a whole API.
  for (const { language, extensions } of SOURCE_EVIDENCE_LANGUAGES) {
    if (setupLanguages.includes(language)) continue;
    const hasSource = extensions.some((ext) => (acc.extCounts[ext] || 0) > 0);
    const hasManifest = foreign.some((f) => normalizeLanguage(f.language) === language);
    if (hasSource || hasManifest) setupLanguages.push(language);
  }

  // JavaScript above is a default, not a finding: an empty directory lands on
  // it too. This separates "a Node repo" from "nothing here at all", which the
  // agent playbook needs so it doesn't hand a full setup to an empty folder.
  const foundCode = acc.packageJsons.length > 0
    || foreign.length > 0
    || acc.sourceFiles.length > 0
    || setupLanguages.some((language) => language !== 'javascript');

  // A docs site, as opposed to the server it documents. Requires zero server
  // evidence of any kind (no server dep, no foreign manifest, no route or
  // server marker in source) AND positive docs evidence, so it is a
  // judgement about what IS here, never just about what isn't. `supported`
  // and `foundCode` stay true: a package.json with Docusaurus in it is real
  // Node code, just not the code Restless wires into. Callers decide
  // whether to stop (agent playbook) or ask (interactive) on this.
  const likelyDocs = nodeEvidence.length === 0 && foreign.length === 0 && docsEvidence.length > 0;

  return {
    // Unsupported means we found another language's project and have no
    // writer for ANY of what is here - not merely that it isn't Node.
    supported: setupLanguages.length > 0,
    nodeEvidence,
    docsEvidence,
    likelyDocs,
    foreign,
    // Foreign languages found, whether or not we can set them up. Drives the
    // "we don't support X yet" copy.
    languages: foreign.map((f) => f.language),
    setupLanguages,
    foundCode,
    // The commonest file extensions the walk saw, for the debug log only. A
    // verdict of "javascript" alone can't tell an empty folder from a repo in
    // a language we don't recognize; this can.
    extensions: topExtensions(acc.extCounts),
  };
}

const MAX_LOGGED_EXTENSIONS = 8;

function topExtensions(extCounts) {
  return Object.fromEntries(
    Object.entries(extCounts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_LOGGED_EXTENSIONS)
      .map(([ext, count]) => [ext || '(none)', count]),
  );
}

/**
 * The headline + detail lines for a repo where the walk found no code at all,
 * for the coding-agent playbook. The interactive flow doesn't need this: its
 * scan shows the user an empty result and lets them point somewhere else.
 */
export function noCodeMessage({ rootDir, cliName = 'restless' } = {}) {
  return {
    headline: `No code found under ${rootDir}.`,
    details: [
      `We looked for ${SUPPORTED_LANGUAGES_LABEL} source and manifests (package.json,`,
      'requirements.txt, Gemfile, go.mod, ...) and found none. Restless sets up an',
      'existing API, so this needs to run from the repo that holds the server code.',
      '',
      `Ask the user where the API lives, then run \`npx ${cliName} init\` from there.`,
      '',
      'Think we got this wrong? Scan anyway with:',
      `  RESTLESS_SKIP_STACK_CHECK=1 npx ${cliName} init`,
    ],
  };
}

/**
 * The headline + detail lines for a repo that looks like a documentation
 * site. `audience` picks the closing instruction: the agent playbook is read
 * by a coding agent who has a user to ask; the interactive flow is read by
 * that user, who gets a yes/no under it instead.
 *
 * The evidence is cited in full because this is the one verdict a human can
 * overrule on sight: "Docusaurus in package.json, 140 Markdown pages" is
 * either obviously right or obviously wrong about their repo.
 */
export function docsRepoMessage(stack, { rootDir, cliName = 'restless', audience = 'agent' } = {}) {
  const headline = 'This looks like a documentation site, not the server that serves your API.';
  const details = [
    `Found: ${stack.docsEvidence.join('; ')}`,
    `Nothing under ${rootDir} declares an HTTP framework or serves routes.`,
    'Restless wires into the code that handles your API\'s requests, so setup',
    'needs to run from the repo that holds the server code.',
    '',
  ];
  if (audience === 'agent') {
    details.push(
      `Ask the user where the API lives, then run \`npx ${cliName} init\` from there.`,
      '',
      'Think we got this wrong? Scan anyway with:',
      `  RESTLESS_SKIP_STACK_CHECK=1 npx ${cliName} init`,
    );
  } else {
    details.push(`If the API is in another repo, run \`npx ${cliName} init\` from there instead.`);
  }
  return { headline, details };
}

/**
 * The headline + detail lines for an unsupported repo, ready to hand to
 * `fatalError` (which appends the "book a call" block itself). Kept next to
 * the detection so both entry points - the interactive setup step and the
 * coding-agent playbook - say the same thing.
 */
export function unsupportedStackMessage(stack, { rootDir, cliName = 'restless' } = {}) {
  const label = describeLanguages(stack.languages);
  const evidence = stack.foreign.flatMap((f) => f.files).slice(0, 6);
  const headline = `We don't support ${label} APIs yet, and that's what this looks like.`;

  const details = [
    `Found: ${evidence.join(', ')}${
      stack.foreign.flatMap((f) => f.files).length > evidence.length ? ', …' : ''
    }`,
    `We can set up ${SUPPORTED_LANGUAGES_LABEL} APIs. Nothing under`,
    `${rootDir} looked like one.`,
    '',
    `Want ${label} support? Email support@restless.ai and we'll prioritize it.`,
    '',
    `Think we got this wrong? Scan anyway with:`,
    `  RESTLESS_SKIP_STACK_CHECK=1 npx ${cliName} init`,
  ];

  return { headline, details };
}

/** The documented escape hatch for a repo we misjudge. */
export function stackCheckDisabled() {
  return process.env.RESTLESS_SKIP_STACK_CHECK === '1';
}
