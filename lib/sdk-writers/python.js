import fs from 'fs';
import path from 'path';
import { getSdkLineSpec } from '../sdk-line-spec.js';
import { probe } from '../sdk-probe.js';
import {
  INLINE_KEY_TODO_TEXT,
  OWNER_ID_CONFIRM_MARKER,
  escapeRegex,
} from './contract.js';
import { balancedArg, createEngine, grepWiringFiles, literalInitArg } from './engine.js';
import {
  anyFileExists,
  firstDeclaredDep,
  grepForLoader,
  noEnvLoader,
  readManifests,
} from '../env-detect.js';
import { portFromPythonSource, pythonFrameworkDefaultPort } from '../test-diagnosis.js';

export { scanPythonCodebase as scanCodebase } from '../find-endpoints-python.js';

/**
 * Owns the SDK setup code in Python source files.
 *
 * The Python dialect of `javascript.js`. Same seven-method surface, written
 * against the real `restlesshq/python` API rather than a transliteration of
 * the Node one, because CONTRACT.md §14 makes public API ergonomics
 * explicitly per-language. What IS shared is the §15 field vocabulary, and
 * that comes through `descriptor.fields` below.
 *
 * The shape this has to recognize:
 *
 *     import restless
 *
 *     client = restless.Restless(os.environ["RESTLESS_KEY"])
 *
 *     @client.setup
 *     def _(request):
 *         return {
 *             "api_key": client.mask(request.headers.get("authorization")),
 *             "owner": {
 *                 "id": workspace_id_for(request),
 *                 "enrich": lambda owner_id: {"label": lookup(owner_id)},
 *             },
 *         }
 *
 *     app.wsgi_app = client.wsgi(app.wsgi_app)   # Flask / Django / WSGI
 *     app = client.asgi(app)                      # FastAPI / Starlette / ASGI
 *
 * Four things differ structurally from JavaScript and drive nearly every
 * regex here:
 *
 *   1. Setup-result keys are QUOTED dict keys (`"api_key":`), not bare
 *      identifiers. Either quote style is legal, so every key match accepts
 *      both.
 *   2. Comments are `#`.
 *   3. `mask` is reachable three ways - `client.mask(...)` (staticmethod via
 *      instance), `restless.mask(...)` (module export), and a bare `mask(...)`
 *      after `from restless import mask`.
 *   4. There are two constructors: the `Restless` class and a functional
 *      `restless()` mirroring the Node SDK. Both are public, so both count as
 *      a real wiring.
 *
 * Like the JS writer, this patches by regex rather than parsing, so it can
 * only touch lines it recognizes. Anything it does not recognize is left
 * alone and surfaced to the user instead of being rewritten badly.
 */

export const descriptor = Object.freeze({
  language: 'python',
  extensions: ['.py'],
  searchGlobs: ['*.py'],
  // What `pip install` names, which is NOT what source imports.
  packageSpecifier: 'restless-sdk',
  importName: 'restless',
  // pyproject.toml first: when a project has both, it is the authoritative
  // one and requirements.txt is often a generated lockfile.
  manifests: ['pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py', 'setup.cfg'],
  installCommand: 'pip install restless-sdk',
  neverRead: Object.freeze(['node_modules/', '.venv/', 'site-packages/']),
  // POSIX ERE for `candidateWiringFiles` (`grep-sdk.js` translates the
  // bracket classes for JavaScript's RegExp). Anchoring on
  // the import keyword is what keeps `restless_var` and prose mentioning
  // "restless" out of the candidate list.
  searchPattern: '(from|import)[[:space:]]+restless',
  commentPrefix: '#',
  // §15 concepts, spelled the Python way (snake_case). Renaming the concept
  // is not allowed; adapting the casing is exactly what §15 permits.
  fields: Object.freeze({
    apiKey: 'api_key',
    owner: 'owner',
    ownerId: 'id',
    enrich: 'enrich',
  }),
  // No pre-rename spelling to accept: this SDK shipped after the rename.
  legacyFields: Object.freeze({}),
  maskCall: Object.freeze({ name: 'mask', styles: ['method', 'module'] }),
  // See javascript.js: no safe universal uninstall, so `api reset` names the
  // manifest and the line and lets the user do it.
  autoUninstall: false,
  phrasing: Object.freeze({
    startHints: '`python manage.py runserver`, `uvicorn app:app --reload`, `flask run`, the command in the README',
    dontTouch: '`pyproject.toml` / `requirements.txt`, `Dockerfile`, or CI config',
    envNote: "The Python SDK does NOT auto-load `.env` - it reads `RESTLESS_KEY` from the process environment. If the project uses python-dotenv or django-environ that already happens; otherwise export it in the shell you start the server in.",
  }),
});

const F = descriptor.fields;

/** A quoted dict key, either quote style: `"api_key"` or `'api_key'`. */
function key(name) {
  return `["']${escapeRegex(name)}["']`;
}

/**
 * The two ways Python attaches the owner, as one alternation.
 *
 *   {"owner": {...}}          inside the dict literal
 *   result["owner"] = {...}   assigned after, usually conditionally
 *
 * The second is not an edge case: it is what you write when the owner is
 * optional, because a dict literal cannot conditionally omit a key without
 * contortions. Both the real pet-store fixtures and the CLI's own setup
 * prompt produce it, so a writer that reads only the first reports "no
 * owner.id is set" for a perfectly good wiring and sends the user into the
 * repair flow.
 */
function ownerAnchorFor(name) {
  return `${key(name)}\\s*(?::|\\]\\s*=)\\s*`;
}

/**
 * The import forms, as three separate patterns rather than one alternation,
 * because they bind different things.
 *
 * Every one tolerates a trailing comment. The real pet-store fixtures all
 * write `import restless  # noqa: E402` (the import sits below a sys.path
 * tweak, so linters need silencing), and Python code in general is full of
 * `# type: ignore` and `# pylint: disable`. An end-of-line anchor that did
 * not allow for them matched none of the fixtures.
 */
const IMPORT_PATTERNS = [
  // `import restless` / `import restless as rl` -> constructors are attributes.
  { kind: 'module', source: String.raw`^[ \t]*import[ \t]+restless(?:[ \t]+as[ \t]+([A-Za-z_]\w*))?[ \t]*(?:#.*)?$` },
  // `from restless import (\n  Restless,\n  mask,\n)` -> parenthesized, may span lines.
  { kind: 'names', source: String.raw`^[ \t]*from[ \t]+restless[ \t]+import[ \t]*\(([\s\S]*?)\)` },
  // `from restless import Restless, restless as make`
  { kind: 'names', source: String.raw`^[ \t]*from[ \t]+restless[ \t]+import[ \t]+([^#(\n]+?)[ \t]*(?:#.*)?$` },
];

// The two public constructors. `Restless` is the class, `restless` the
// functional form the SDK ships to mirror Node's `restless(key)`.
const CONSTRUCTORS = ['Restless', 'restless'];

/**
 * Resolve every local name that could be a Restless constructor in this file,
 * across all the import forms Python allows.
 */
function constructorBindings(content) {
  const bindings = [];
  for (const { kind, source } of IMPORT_PATTERNS) {
    const re = new RegExp(source, 'gm');
    let m;
    while ((m = re.exec(content)) !== null) {
      if (kind === 'module') {
        const mod = m[1] || descriptor.importName;
        for (const ctor of CONSTRUCTORS) bindings.push(`${escapeRegex(mod)}\\.${ctor}`);
        continue;
      }
      for (const spec of (m[1] || '').split(',')) {
        const cleaned = spec.trim();
        if (!cleaned) continue;
        const [name, alias] = cleaned.split(/\s+as\s+/).map((s) => s.trim());
        if (CONSTRUCTORS.includes(name)) bindings.push(escapeRegex(alias || name));
      }
    }
  }
  return [...new Set(bindings)];
}

/** Does this file import the SDK at all? The loose check. */
export function hasSdkReference(content) {
  if (!content) return false;
  return IMPORT_PATTERNS.some(({ source }) => new RegExp(source, 'm').test(content));
}

/**
 * Is the SDK actually constructed here? The strict check, and the one that
 * decides whether the AI wiring pass gets skipped on a re-run.
 *
 * Requires an import AND a call through a binding that import created, so a
 * file that imports `mask` for a unit test does not read as wired.
 */
export function hasInit(content) {
  if (!content) return false;
  const bindings = constructorBindings(content);
  return bindings.some((b) => new RegExp(`${b}\\s*\\(`).test(content));
}

export const candidateWiringFiles = grepWiringFiles(descriptor);

/** Locate the constructor call and return `{ index, argsStart, args }`. */
function findConstructorCall(content) {
  for (const b of constructorBindings(content)) {
    const m = content.match(new RegExp(`${b}\\s*\\(`));
    if (!m) continue;
    const argsStart = m.index + m[0].length;
    const args = balancedArg(content, argsStart);
    if (args === null) continue;
    return { index: m.index, argsStart, args, matched: m[0] };
  }
  return null;
}


/**
 * Interpreters to try, best first.
 *
 * A project-local virtualenv wins over whatever `python3` resolves to on PATH,
 * because that is the interpreter the user's server will actually run under -
 * checking the system one would report "not installed" for a correctly
 * installed venv, or worse, "installed" when the venv lacks it. `VIRTUAL_ENV`
 * covers an already-activated shell.
 */
function pythonCandidates(dir) {
  const bin = process.platform === 'win32' ? 'Scripts' : 'bin';
  const exe = process.platform === 'win32' ? 'python.exe' : 'python';
  const out = [];
  for (const venv of ['.venv', 'venv', 'env']) out.push(path.join(dir, venv, bin, exe));
  if (process.env.VIRTUAL_ENV) out.push(path.join(process.env.VIRTUAL_ENV, bin, exe));
  out.push('python3', 'python');
  return out;
}

/**
 * Ask an interpreter whether it can import the SDK, and where from.
 *
 * Asking the interpreter rather than looking for a directory is what makes
 * this work for every install shape at once: a registry install, `pip install
 * -e ../python-sdk`, a `.pth` file, a vendored copy on PYTHONPATH, poetry, uv,
 * pipenv. That matters twice over - it is how we develop against a local
 * checkout, and it is how plenty of real users work in monorepos.
 */
export function resolveInstalled(packageDir, { budget } = {}) {
  for (const python of pythonCandidates(packageDir)) {
    if (python.includes(path.sep) && !fs.existsSync(python)) continue;
    const out = probe(python, ['-c', 'import restless, sys; sys.stdout.write(restless.__file__ or "")'], {
      cwd: packageDir,
      budget,
    });
    if (out) return out;
    if (budget?.spent()) break;
  }
  return null;
}

export function describeMissing(packageDir) {
  return [
    `Tried importing \`${descriptor.importName}\` with the interpreters under ${packageDir}`,
    `(.venv, venv, $VIRTUAL_ENV, then python3) - none of them could.`,
    `If your project uses a virtualenv we didn't find, activate it and re-run.`,
  ];
}

/**
 * Does this project populate the environment before the client constructs?
 *
 * Lives on the writer rather than in a `language === 'python'` branch inside
 * `envLoader.js`, so the registry is the only thing that maps a language to
 * its behaviour and `assertWriterShape` can require it.
 *
 * Unlike Node, the Python SDK does NOT auto-load `.env` - install.md §12 says
 * so explicitly, because Python has no single convention and the SDK ships
 * with no dependencies. So `mode: 'none'` means something different here than
 * for Node: there is no `.env` walk to fall back on, and the honest wiring is
 * a no-arg `Restless()` that reads whatever the process environment has.
 */
export function detectEnvLoader(installDir) {
  const declared = readManifests(installDir, descriptor.manifests);

  // Django and Flask both load .env themselves in the common setups, so a
  // key in the environment is reliable before the client is constructed.
  const dep = firstDeclaredDep(declared, [
    ['django-environ', 'django-environ is installed'],
    ['python-decouple', 'python-decouple is installed'],
    ['python-dotenv', 'python-dotenv is installed'],
    ['pydantic-settings', 'pydantic-settings is installed'],
    ['environs', 'environs is installed'],
    ['dynaconf', 'dynaconf is installed'],
  ]);
  if (dep) return dep;

  // Source-level loading, which is how plenty of projects do it without
  // declaring the dep at the top level (it arrives via a framework extra).
  const loaded = grepForLoader(installDir, {
    pattern: 'load_dotenv|dotenv_values|environ\\.Env|from dotenv import',
    globs: ['*.py'],
    ignore: ['site-packages', '/.venv/'],
    describe: (file) => `dotenv loaded in ${file}`,
  });
  if (loaded) return loaded;

  // A manage.py project reads settings through Django, which most deployments
  // populate from the real environment rather than a file.
  if (anyFileExists(installDir, ['manage.py'])) {
    return noEnvLoader('Django project, env comes from the process environment');
  }

  return noEnvLoader();
}

export const portFiles = Object.freeze([
  'Procfile', 'manage.py', 'pyproject.toml', 'Makefile', 'docker-compose.yml',
]);

export const parsePort = portFromPythonSource;

/**
 * 3000 is a Node convention and would be wrong for every Python framework;
 * 8000 is the closest thing Python has to a default.
 */
export function defaultLocalPort(searchDir, framework = '') {
  const port = pythonFrameworkDefaultPort(declaredDeps(searchDir), framework);
  if (port) return { port, source: 'the framework default' };
  return { port: '8000', source: null };
}

/** Dependency names declared in any Python manifest, lowercased. */
function declaredDeps(searchDir) {
  const names = new Set();
  const text = readManifests(searchDir, descriptor.manifests);
  for (const m of text.matchAll(/^[\s"']*([A-Za-z][\w.-]*)/gm)) names.add(m[1].toLowerCase());
  for (const m of text.matchAll(/["']([A-Za-z][\w.-]*)/g)) names.add(m[1].toLowerCase());
  return [...names];
}

/** Render the init argument for the resolved key-delivery mode. */
function buildInitArg(ctx) {
  const literal = literalInitArg(ctx);
  if (literal !== null) return literal;
  const spec = getSdkLineSpec(ctx);
  // `.get()` rather than `os.environ[...]`: a subscript raises KeyError when
  // the key is not set yet, which for a client constructed at module import
  // (the normal place) takes the whole app down at startup over an
  // observability variable. `.get()` returns None, the SDK falls back to its
  // own os.environ lookup, and a missing key degrades to "captured, not
  // uploaded" exactly as CONFIG-002 intends.
  if (spec.form === 'env-ref') return `os.environ.get(${JSON.stringify(spec.value)})`;
  return '';
}

/**
 * The Python dialect, and the five shared methods built from it.
 *
 * Everything above is genuinely Python: how it imports, how it names a
 * constructor, how it quotes a dict key. The read-and-patch algorithms below
 * are not, so they come from the engine rather than from a fourth copy here.
 */
const engine = createEngine({
  descriptor,
  confirmMarker: OWNER_ID_CONFIRM_MARKER,
  inlineKeyTodoText: INLINE_KEY_TODO_TEXT,
  hasSdkReference,
  findConstructorCall,
  initLine: (line, block) =>
    constructorBindings(block).some((b) => new RegExp(`${b}\\s*\\(`).test(line)),
  // Quoted dict key plus its colon: `"api_key":` or `'api_key':`.
  fieldKey: (name) => `${key(name)}\\s*:`,
  ownerAnchor: () => ownerAnchorFor(F.owner),
  // `result["owner"] = {...}` puts `result` between the confirm comment and the
  // anchor on the next line.
  confirmPrefix: '(?:result)?',
  renderOwnerLine: (indent, expr) => `${indent}"${F.owner}": {"${F.ownerId}": ${expr}},`,
  buildInitArg,
  // `os.environ["X"]`, `os.environ.get("X")`, `os.getenv("X")`.
  envRef: (arg) => {
    const m = arg.match(
      /os\.environ(?:\.get)?\s*[[(]\s*["']([A-Za-z_]\w*)["']|os\.getenv\s*\(\s*["']([A-Za-z_]\w*)["']/,
    );
    return m ? m[1] || m[2] : null;
  },
});

export const {
  parse,
  readBlockFields,
  setOwnerId,
  stripOwnerIdConfirm,
  canonicalizeInitArg,
} = engine;
