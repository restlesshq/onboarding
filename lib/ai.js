import fs from 'fs';
import { normalizeLanguage } from './sdk-writers/languages.js';
import { getSdkWriter } from './sdk-writers/index.js';
import { formatPathList } from './sdk-writers/contract.js';
import path from 'path';
import { startSpinner } from './ui.js';
import * as timings from './timings.js';
import { getGitRoot } from './pathGuard.js';
import { AgentAuthError, fatalError } from './errors.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
export const pkgRoot = path.resolve(__dirname, '..');

// Default provider - swap this out or make it configurable
import claude from '../providers/claude.js';
import codex from '../providers/codex.js';

const PROVIDERS = { claude, codex };
let provider = claude;

export function setProvider(p) {
  if (typeof p === 'string') {
    const next = PROVIDERS[p];
    if (!next) throw new Error(`Unknown AI provider: ${p}`);
    provider = next;
    return;
  }
  provider = p;
}

export function getProvider() {
  return provider;
}

/**
 * The registered name of the active provider, for logs and timing spans.
 * Derived from the registry rather than compared against one import, so a
 * provider swapped in by a test or a future backend doesn't get reported
 * as claude.
 */
function providerName() {
  return Object.entries(PROVIDERS).find(([, p]) => p === provider)?.[0] || 'custom';
}

/**
 * Normalize a status value to a string for the standalone spinner (which
 * only shows one line). Objects become "phase - detail" or "detail" alone.
 */
function statusToString(info) {
  if (!info) return '';
  if (typeof info === 'string') return info;
  if (info.phase && info.detail) return `${info.phase}: ${info.detail}`;
  return info.detail || info.phase || '';
}

// Prepended to every AI prompt. The agent has Bash access and tends to
// reach for `python -c '...'` or `python3 -m json.tool` for tasks Node
// does natively - that fails silently on machines without python (lots
// of fresh Macs, most Windows boxes, minimal Docker images, etc.). Pin
// it to interpreters the user is guaranteed to have, given they're
// running a Node CLI: Node itself, plus the standard POSIX text tools.
const TOOL_CONSTRAINTS = `## Environment

You're running in a Node-based CLI on the user's machine. Bash is available, but:

- **Do NOT use \`python\`, \`python3\`, \`pip\`, \`ruby\`, \`gem\`, \`perl\`, or any other interpreter the user might not have installed.** Many users (especially on fresh macOS, Windows, minimal Docker images) won't have python or ruby - reaching for them is a silent failure waiting to happen.
- **For JSON / text manipulation, use Node** (\`node -e "..."\` is fine), or POSIX tools that ship with the OS: \`grep\`, \`sed\`, \`awk\`, \`find\`, \`cat\`, \`head\`, \`tail\`. Do not assume \`jq\` is installed either.
- **Do not invoke a language toolchain you weren't asked to use.** If the user is on a JavaScript project, don't shell out to \`python -m json.tool\` to validate JSON - parse it with \`node -e\`.

`;

/**
 * Where the project is, stated up front. Without it the model fills the gap
 * from memory, which in a git worktree names a different checkout.
 */
export function locationPreamble(cwd, root = getGitRoot()) {
  if (!cwd) return '';
  const dir = path.resolve(cwd);
  const boundary = root ? path.resolve(root) : dir;
  const scope = boundary === dir
    ? `Change files only inside \`${dir}\``
    : `The repository root is \`${boundary}\`; change files only inside it`;
  return `## Project location

The project is at \`${dir}\`. ${scope}, using paths relative to \`${dir}\` or absolute paths that start with \`${boundary}\`. If you know this repository from another path (from memory, or an earlier session), ignore that path: it is a different checkout, and changes there never reach this one.

`;
}

// Name of the last prompt file `loadPrompt` read. Used only to label a
// timing span when a `runAI` call site didn't pass one: every call site
// builds its prompt immediately before the call, so this is right in
// practice, and a slightly-off label in a profile is a better outcome
// than an unnamed span or a required argument nobody remembers to pass.
let lastLoadedPrompt = '';

/**
 * `maxTurns` and `onError` pass straight through to the provider; see
 * `providers/claude.js` for what each is for. Omitting them preserves the
 * original behaviour exactly: a 30-turn budget, and SDK errors swallowed into
 * a partial result for the caller to re-check.
 *
 * `label` names this call in the timing report (see `lib/timings.js`), and
 * `background` says the call was started to run alongside its caller rather
 * than inside it, so the timing tree parents it correctly. Neither has any
 * effect on the run itself.
 */
export async function runAI(prompt, cwd, { setSpinner, maxTurns, onError, onReport, label, background = false } = {}) {
  const standalone = !setSpinner;
  const initial = { phase: 'Analyzing', detail: 'Thinking…' };
  const spinner = standalone ? startSpinner(statusToString(initial)) : null;

  if (setSpinner) setSpinner(initial);

  // Prepend the environment-constraint preamble to every prompt so we
  // don't have to repeat the rule in each individual prompts/*.md file.
  const fullPrompt =
    typeof prompt === 'string' ? TOOL_CONSTRAINTS + locationPreamble(cwd) + prompt : prompt;

  // AI turns are the single largest contributor to a slow `init`, and they
  // vary hugely by prompt - so time each one under its own name rather
  // than reporting one lumped "AI" total.
  const endSpan = timings.start(label || lastLoadedPrompt || 'unlabelled', {
    kind: timings.KINDS.AI,
    provider: providerName(),
    promptChars: fullPrompt?.length ?? 0,
    // A call started to run alongside its caller must not adopt whatever the
    // caller does next as a child span. See `timings.start`.
    background,
  });
  let result;
  try {
    result = await provider.run(fullPrompt, cwd, {
      maxTurns,
      onError,
      onReport,
      onStatus(info) {
        // info is either a string (legacy) or { phase, detail }.
        if (spinner) spinner.update(statusToString(info));
        if (setSpinner) setSpinner(info);
      },
    });
  } catch (err) {
    if (!(err instanceof AgentAuthError)) throw err;
    if (spinner) spinner.stop();
    try {
      fatalError(err.headline, err.details);
    } catch {
      // The FatalExit is expected: fatalError has already started the exit.
    }
    // Callers swallow AI errors to retry, and with no login every retry fails
    // the same way, so never hand control back. The exit ends the run.
    return new Promise(() => {});
  } finally {
    endSpan({ resultChars: result?.length ?? 0 });
  }

  if (spinner) spinner.stop();
  if (setSpinner) setSpinner('');

  return result;
}

/**
 * Load `<name>-<language>.md` when it exists, else `<name>.md`.
 *
 * Wiring instructions are irreducibly per-language - the JavaScript one is
 * mostly about CJS-vs-ESM, the Next.js router split and an old-API migration,
 * none of which mean anything in Python. Parameterizing one file into
 * covering both would make the JavaScript path (the one with real users)
 * harder to read and easier to break, so each language gets its own file and
 * shares the ones that are genuinely generic.
 */
export function languagePromptVars(language) {
  const { descriptor } = getSdkWriter(language);
  return {
    sdkPackage: descriptor.packageSpecifier,
    importName: descriptor.importName || descriptor.packageSpecifier,
    manifest: descriptor.manifests.slice(0, 2).join(' / '),
    // Off the descriptor, not a `python ? ... : ...` here. That ternary sent
    // `node_modules/` to Ruby and Go, so three shipped prompts told the agent
    // to avoid a directory those projects do not have and said nothing about
    // `vendor/bundle/` or the module cache. Named for the descriptor field so
    // the two cannot drift again without the mismatch being obvious.
    neverRead: formatPathList(descriptor.neverRead),
    apiKeyField: descriptor.fields.apiKey,
    ownerField: descriptor.fields.owner,
    ownerIdField: descriptor.fields.ownerId,
    commentPrefix: descriptor.commentPrefix,
  };
}

export function loadPromptForLanguage(name, language, vars = {}) {
  const specific = path.join(pkgRoot, 'prompts', `${name}-${normalizeLanguage(language)}.md`);
  if (fs.existsSync(specific)) {
    lastLoadedPrompt = `${name}-${normalizeLanguage(language)}`;
    let content = fs.readFileSync(specific, 'utf8');
    for (const [key, value] of Object.entries(vars)) {
      content = content.replaceAll(`{{${key}}}`, value);
    }
    return content;
  }
  return loadPrompt(name, vars);
}

export function loadPrompt(name, vars = {}) {
  lastLoadedPrompt = name;
  const promptPath = path.join(pkgRoot, 'prompts', `${name}.md`);
  let content = fs.readFileSync(promptPath, 'utf8');
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  return content;
}
