import fs from 'fs';
import path from 'path';
import { bold, dim, green, red, yellow, cyan, ask, singleSelect, askYesNo } from '../lib/ui.js';
import { loadSettings, saveSettings, findApiEntry } from '../lib/settings.js';
import { loadOas } from '../lib/oas-auth.js';
import { CLI_NAME } from '../lib/config.js';
import { isInteractive } from '../lib/env.js';
import { safeWriteFileSync, safeMkdirSync } from '../lib/pathGuard.js';
import {
  MANAGED_OAS_FILE,
  adoptOasFile,
  countOasEndpoints,
  describeOasSource,
  describeSpecOutcome,
  diffOperations,
  fetchOasFromUrl,
  hashOasFile,
  isManagedSpec,
  oasSourceFacets,
} from '../lib/oas-source.js';
import { fetchDashboardSpec, compareWithDashboard } from '../lib/project-sync.js';
import { combineSpecFiles } from '../lib/oas-combine.js';
import { generateOasWithAi, locateOasWithAi, pickOasCandidate, describeCoverageGap } from './generate-oas.js';
import { describeCheck } from './update-render.js';
import { loadCachedToken } from '../lib/cli-token.js';
import * as debug from '../lib/debug.js';

/**
 * `npx restless update` -> refreshing the spec.
 *
 * This used to be a stub that told you to re-run `init`, and the reason it
 * stayed a stub is that "refresh my spec" has no single meaning. A spec that
 * came from a URL wants re-fetching. A spec you maintain by hand wants
 * re-reading and re-validating, and must never be regenerated over. Only the
 * AI and framework-generator kinds want the routes read again.
 *
 * What each kind means is declared once, in `OAS_SOURCES` in
 * lib/oas-source.js. This file owns the two things that table can't: how a
 * refresh actually reproduces a spec, and the rule that it always does so
 * somewhere disposable.
 *
 * THE RULE: nothing here writes to the developer's spec. Every strategy stages
 * into `REFRESH_DIR`, and only `applySpecChange` - called after consent - moves
 * a staged file into place. There used to be two implementations of refresh, a
 * staged one for the up-front check and an unstaged one behind the menu, and
 * the unstaged one could delete a spec and then report "Nothing changed".
 */

/**
 * Scratch DIRECTORY for a refresh we haven't been given permission to keep.
 *
 * A directory rather than a file because `locateOasWithAi` copies a chosen
 * candidate to `openapi.<ext>` alongside whatever path it is handed - so
 * staging to a flat `.oas-refresh.json` would put that copy at
 * `.restless/openapi.json`, on top of the very spec the user is still deciding
 * whether to replace. Giving the whole operation its own directory means
 * nothing it does can reach their file.
 */
const REFRESH_DIR = '.restless/.oas-refresh';

/** Remove the scratch directory, and the flat files an older build used. */
export function cleanRefreshTemp(rootDir) {
  try { fs.rmSync(path.join(rootDir, REFRESH_DIR), { recursive: true, force: true }); } catch {}
  for (const ext of ['.json', '.yaml']) {
    try { fs.rmSync(path.join(rootDir, `${REFRESH_DIR}${ext}`)); } catch {}
  }
}

let _tempGuardRoot = null;
let _tempHandlersInstalled = false;

/**
 * Make sure a staged refresh can't outlive the process.
 *
 * The staging directory lives under `.restless/`, which is committed, so a run
 * abandoned partway leaves a stray directory someone could commit.
 *
 * Called by `stageRefresh` BEFORE it writes anything, not by the caller after a
 * change is found - a Ctrl-C during the fetch or the agent pass is the most
 * likely moment to abandon a run, and that is exactly the window the old
 * placement left uncovered.
 *
 * Two handlers because they cover different exits: raw-mode prompts read Ctrl-C
 * as `\\x03` and call `process.exit`, which runs `exit` handlers; a SIGINT
 * delivered while we are not in raw mode kills the process without them.
 * Neither survives a SIGKILL or a crash, so `cleanRefreshTemp` runs at the
 * start of every stage as well.
 */
function guardRefreshTemp(rootDir) {
  _tempGuardRoot = rootDir;
  // Install once per process. Re-arming after a release used to add a second
  // pair of listeners every time.
  if (_tempHandlersInstalled) return;
  _tempHandlersInstalled = true;
  const clean = () => {
    if (_tempGuardRoot) cleanRefreshTemp(_tempGuardRoot);
  };
  process.once('exit', clean);
  process.once('SIGINT', () => {
    clean();
    process.exit(130);
  });
}

/** Stop guarding, once the staged file has been applied or deliberately dropped. */
function releaseRefreshTemp() {
  _tempGuardRoot = null;
}

/** Where a regenerate is allowed to land. Never the user's own file: a spec
 *  from `found`/`file` lives where they keep it, so regenerating targets the
 *  path we own and re-points `oasFile` instead of overwriting their work. */
export function regenerateTarget(apiEntry) {
  return isManagedSpec(apiEntry.oasFile) ? apiEntry.oasFile : MANAGED_OAS_FILE;
}

/** Parse the spec currently on disk, so a refresh can be diffed against it. */
function readCurrentSpec(rootDir, oasFile) {
  if (!oasFile) return null;
  const abs = path.join(rootDir, oasFile);
  if (!fs.existsSync(abs)) return null;
  try { return loadOas(abs); } catch { return null; }
}

/**
 * Where a staged spec should end up if the developer accepts it.
 *
 * Their own file is never the target: a `found` / `file` spec lives where they
 * keep it, so an accepted refresh lands on the path we own and re-points
 * `oasFile`. The extension follows the staged file, since a URL that used to
 * serve JSON may now serve YAML.
 */
function resolveTarget(apiEntry, stagedFile) {
  if (apiEntry.oasFile && isManagedSpec(apiEntry.oasFile)) return apiEntry.oasFile;
  return `${MANAGED_OAS_FILE.replace(/\.json$/, '')}${path.extname(stagedFile)}`;
}

/**
 * How a refresh reproduces a spec, one entry per `strategy` named in
 * `OAS_SOURCES`. Every one of these writes into `destDir` and nowhere else.
 *
 * Each strategy returns the `oasSource` to record alongside the file, because
 * provenance belongs with whatever produced the spec. Hard-coding it at the
 * call site is the bug this whole feature started from: `finalizeApi` was
 * called with a literal `{kind:'ai'}`, so a hand-written spec came back on a
 * re-run described as "generated with AI".
 *
 * `reread` has no entry on purpose - a spec the developer maintains produces no
 * new bytes, so there is nothing to stage. `revalidate` handles it.
 */
const REFRESH_STRATEGIES = {
  async fetch({ apiEntry, rootDir, destDir, setSpinner }) {
    const url = apiEntry.oasSource?.url;
    if (!url) return { ok: false, error: 'No URL recorded for this spec.' };
    const res = await fetchOasFromUrl({ url, rootDir, destDir, setSpinner });
    if (!res.ok) return { ok: false, error: res.error, detail: res.detail };
    return { ok: true, oasFile: res.oasFile, oasSource: { kind: 'url', url } };
  },

  async locate({ apiEntry, rootDir, packageDir, destDir, setSpinner, onAmbiguous }) {
    const summary = apiEntry.oasSource?.summary;
    if (!summary) return { ok: false, error: 'Nothing recorded to replay.' };
    const res = await locateOasWithAi({
      input: summary,
      rootDir,
      destFile: path.join(path.relative(rootDir, destDir), 'openapi.json'),
      packageDir,
      setSpinner,
      onAmbiguous,
    });
    if (!res.ok) return { ok: false, error: res.error };
    return {
      ok: true,
      oasFile: res.oasFile,
      oasSource: res.combinedPaths
        ? { kind: 'combined', paths: res.combinedPaths }
        : { kind: 'describe', summary: res.summary || summary },
    };
  },

  async combine({ apiEntry, rootDir, destDir }) {
    const paths = apiEntry.oasSource?.paths;
    if (!paths?.length) return { ok: false, error: 'No specs recorded to combine.' };
    const res = await combineSpecFiles({
      rootDir, paths, destFile: path.join(path.relative(rootDir, destDir), 'openapi.json'),
    });
    if (!res.ok) return { ok: false, error: res.error, detail: res.detail };
    return { ok: true, oasFile: res.oasFile, oasSource: { kind: 'combined', paths } };
  },

  generate(opts) { return generateInto(opts, false); },
  'generate-native': (opts) => generateInto(opts, true),
};

/**
 * The strategies that produce bytes. Exported so a test can bind this to the
 * `strategy` values in `OAS_SOURCES`: a kind naming a strategy nothing
 * implements would fail at the moment someone tried to refresh it, which is
 * the worst possible time to find out.
 */
export const REFRESH_STRATEGY_NAMES = Object.keys(REFRESH_STRATEGIES);

async function generateInto({ apiEntry, rootDir, packageDir, destDir, setSpinner }, preferNative) {
  const framework = apiEntry.framework || apiEntry.oasSource?.framework || null;
  const gen = await generateOasWithAi({
    rootDir,
    packageDir,
    apiRootDir: apiEntry.rootDir || '.',
    name: apiEntry.name,
    framework,
    language: apiEntry.language || 'javascript',
    existingOasFile: apiEntry.oasFile || null,
    preferNative,
    oasFile: path.join(path.relative(rootDir, destDir), 'openapi.json'),
    setSpinner,
  });
  if (!gen.ok) {
    return { ok: false, error: gen.error || "The generator didn't produce a spec." };
  }
  return {
    ok: true,
    oasFile: gen.oasFile,
    oasSource: preferNative ? { kind: 'native', framework } : { kind: 'ai' },
    coverage: gen.coverage,
  };
}

/**
 * Produce a fresh copy of the spec into the scratch directory, whatever its
 * source. The single implementation of "go and get it again" - the up-front
 * check, the menu, and `--refresh` all come through here.
 */
export async function stageRefresh({
  apiEntry, rootDir, packageDir = rootDir, strategy, setSpinner = () => {}, onAmbiguous = null,
}) {
  const run = REFRESH_STRATEGIES[strategy];
  if (!run) return { ok: false, error: `Don't know how to refresh a ${strategy} spec.` };

  // Clear first, then arm the guard, then write. In that order there is no
  // window where a staged file exists unguarded.
  cleanRefreshTemp(rootDir);
  guardRefreshTemp(rootDir);
  const destDir = path.join(rootDir, REFRESH_DIR);

  const res = await run({ apiEntry, rootDir, packageDir, destDir, setSpinner, onAmbiguous });
  if (!res.ok) {
    cleanRefreshTemp(rootDir);
    releaseRefreshTemp();
  }
  return res;
}

/**
 * Compare a freshly-staged spec against the one on disk, and describe the
 * difference in the shape every caller branches on.
 *
 * Shared by every strategy so they all report a change the same way.
 */
function compareStaged({ apiEntry, rootDir, stagedFile, oasSource, coverage = null }) {
  const currentAbs = apiEntry.oasFile ? path.join(rootDir, apiEntry.oasFile) : null;
  const stagedAbs = path.join(rootDir, stagedFile);
  const endpoints = countOasEndpoints(stagedAbs);
  if (endpoints === null) {
    cleanRefreshTemp(rootDir);
    releaseRefreshTemp();
    return { kind: 'failed', reason: "the refreshed spec didn't parse" };
  }

  const hasCurrent = currentAbs && fs.existsSync(currentAbs);
  // Canonical, not byte-level, so a generator that merely reformatted its
  // output does not read as a change worth pushing. A real 560-byte reformat
  // turned out to be 11 bytes of actual difference.
  if (hasCurrent && hashOasFile(currentAbs) === hashOasFile(stagedAbs)) {
    cleanRefreshTemp(rootDir);
    releaseRefreshTemp();
    return { kind: 'unchanged', endpoints };
  }

  return {
    kind: 'staged',
    diff: diffOperations(hasCurrent ? loadOas(currentAbs) : null, loadOas(stagedAbs)),
    endpoints,
    // Staged, not applied. Only `applySpecChange` moves it into place.
    tempFile: stagedFile,
    targetFile: resolveTarget(apiEntry, stagedFile),
    oasSource,
    // Surface an incomplete regeneration even when the diff looks fine.
    ...(coverage && !coverage.ok && coverage.missing?.length ? { coverage } : {}),
  };
}

/**
 * Look for spec changes before asking the user anything.
 *
 * Only meaningful for kinds with `autoCheck` - the ones with a source to go
 * back to. Nothing here touches the spec on disk.
 *
 * Returns a discriminated result, so a renderer switches once instead of
 * testing a combination of booleans:
 *   'staged'     a fresh copy differs; `diff` says how, `tempFile` holds it
 *   'on-disk'    the developer's own file changed since we last pushed it
 *   'unchanged'  nothing differs
 *   'unknown'    we can't tell (a maintained spec never pushed from here)
 *   'failed'     the check itself didn't work; `reason` says why
 *
 * Anything other than a change means fall through to the normal menu. A
 * failure here must never block someone who only wanted to edit a setting, so
 * every error path returns rather than throwing.
 */
function checkFileOnDisk({ rootDir, apiEntry }) {
  const currentAbs = apiEntry.oasFile ? path.join(rootDir, apiEntry.oasFile) : null;
  if (!currentAbs || !fs.existsSync(currentAbs)) {
    return { kind: 'failed', reason: `${apiEntry.oasFile || 'the spec'} is not on disk` };
  }
  const endpoints = countOasEndpoints(currentAbs);
  if (endpoints === null) {
    return { kind: 'failed', reason: `${apiEntry.oasFile} no longer parses as an OpenAPI spec` };
  }
  if (!apiEntry.oasHash) {
    // Never pushed from this checkout, or pushed by a CLI that predates the
    // fingerprint. Can't claim a change, and shouldn't claim there isn't one.
    return { kind: 'unknown', endpoints, targetFile: apiEntry.oasFile, oasSource: apiEntry.oasSource };
  }
  if (hashOasFile(currentAbs) === apiEntry.oasHash) return { kind: 'unchanged', endpoints };
  return {
    kind: 'on-disk',
    endpoints,
    previousEndpoints: apiEntry.oasOperationCount ?? null,
    // No staged file: the change is already on disk, and pushing is what's
    // outstanding. And no operation list - a hash can't reconstruct one.
    targetFile: apiEntry.oasFile,
    oasSource: apiEntry.oasSource,
  };
}

export async function checkForSpecChanges({
  rootDir, packageDir = rootDir, apiEntry, setSpinner = () => {},
}) {
  const facets = oasSourceFacets(apiEntry.oasSource?.kind);

  // `file` / `found`: the file on disk IS the spec, so there is nothing to
  // fetch and nothing to stage. All we can do is compare it against the
  // fingerprint recorded at the last push.
  if (facets.strategy === 'reread') return checkFileOnDisk({ rootDir, apiEntry });

  const staged = await stageRefresh({
    apiEntry, rootDir, packageDir, strategy: facets.strategy, setSpinner,
  });
  if (!staged.ok) return { kind: 'failed', reason: staged.error };
  return compareStaged({
    apiEntry, rootDir, stagedFile: staged.oasFile, oasSource: staged.oasSource, coverage: staged.coverage,
  });
}

/**
 * The local check and the dashboard comparison, together and concurrently.
 *
 * They answer different questions - "is my file stale against its own source"
 * and "is what Restless serves stale against my file" - and neither depends on
 * the other, so running them in sequence just made a status check take as long
 * as both. The local half can be tens of seconds when it runs an agent.
 *
 * A cached token only: a status question must never trigger a browser login.
 */
export async function inspectProject({
  rootDir, packageDir = rootDir, apiEntry, setSpinner = () => {}, checkSpec = true,
}) {
  const cached = loadCachedToken(apiEntry.projectId);

  const localCheck = checkSpec
    ? checkForSpecChanges({ rootDir, packageDir, apiEntry, setSpinner })
      .catch((err) => ({ kind: 'failed', reason: err.message }))
    : Promise.resolve(null);

  const dashboardCheck = (async () => {
    if (!cached) {
      return { status: 'unauthorized', reason: 'no cached CLI session on this machine' };
    }
    const remote = await fetchDashboardSpec({
      projectId: apiEntry.projectId, token: cached.token,
    });
    const cmp = compareWithDashboard({
      localOas: readCurrentSpec(rootDir, apiEntry.oasFile),
      localHash: apiEntry.oasFile ? hashOasFile(path.join(rootDir, apiEntry.oasFile)) : null,
      remote,
    });
    if (cmp) return cmp;
    return { status: 'unavailable', reason: remote.error || 'unknown' };
  })();

  const [check, dashboard] = await Promise.all([localCheck, dashboardCheck]);
  debug.log('update.inspect', {
    kind: apiEntry.oasSource?.kind ?? null,
    check: check?.kind ?? null,
    dashboard: dashboard.status,
  });
  return { check, dashboard, authorized: !!cached };
}

/**
 * Move a staged refresh into place. Separated from the check so nothing the
 * user hasn't agreed to can reach their spec.
 *
 * A result with no `tempFile` is already where it belongs - a spec the
 * developer maintains, or one we only re-pointed at - so this is a no-op that
 * returns the path.
 */
export function applySpecChange({ rootDir, check }) {
  if (!check.tempFile) return check.targetFile;
  const from = path.join(rootDir, check.tempFile);
  const to = path.join(rootDir, check.targetFile);
  safeMkdirSync(path.dirname(to), { recursive: true });
  safeWriteFileSync(to, fs.readFileSync(from, 'utf8'));
  cleanRefreshTemp(rootDir);
  releaseRefreshTemp();
  return check.targetFile;
}

/** Drop a staged refresh the developer declined. */
export function discardSpecChange(rootDir) {
  cleanRefreshTemp(rootDir);
  releaseRefreshTemp();
}

/**
 * The action list for this spec. The first entry is the primary action, taken
 * from how the spec got here; the rest are always available.
 */
export function buildActions(apiEntry) {
  const src = apiEntry.oasSource || {};
  const facets = oasSourceFacets(src.kind);

  // Regenerating is offered to everyone, but never as the default for a spec
  // we didn't write - that is how you lose someone's hand-written file.
  const regenerate = {
    key: 'regenerate',
    label: 'Regenerate from your routes',
    hint: 'Reads your code and rewrites the spec, locally.',
  };
  const primary = facets.action(apiEntry, src) || regenerate;
  const actions = [primary, {
    key: 'adopt',
    label: 'Point at a different spec',
    hint: 'A file path, a URL, or just tell us where it is.',
  }];

  if (!actions.some((a) => a.key.startsWith('regenerate'))) {
    actions.push({
      ...regenerate,
      label: 'Regenerate from your routes instead',
      hint: `Writes a new spec to ${regenerateTarget(apiEntry)}. Your current file is left alone.`,
    });
  }
  return actions;
}

/** Which staging strategy an action key uses. */
const ACTION_STRATEGY = {
  refetch: 'fetch',
  replay: 'locate',
  recombine: 'combine',
  regenerate: 'generate',
  'regenerate-native': 'generate-native',
};

/**
 * Ask where a spec should come from, and go get it - staged, like everything
 * else. Returns a check-shaped result.
 */
async function stageFromPrompt({ rootDir, packageDir, apiEntry, setSpinner }) {
  console.log('');
  console.log(`  ${bold('Where is the spec?')}`);
  console.log('');
  console.log(`  ${dim('A file path, a URL, or just tell us where to look:')}`);
  console.log(`  ${dim('  docs/openapi.yaml')}`);
  console.log(`  ${dim('  https://api.acme.com/openapi.json')}`);
  console.log(`  ${dim("  it's served at /docs-json")}`);
  console.log('');
  const input = (await ask(`  ${cyan('❯')} `)).trim();
  if (!input) return { kind: 'failed', reason: 'no spec given' };

  const staged = await stageSpecFromInput({
    input, rootDir, packageDir, apiEntry, setSpinner, onAmbiguous: pickOasCandidate,
  });
  if (!staged.ok) {
    for (const line of describeSpecOutcome(staged)) console.log(line);
    return { kind: 'failed', reason: staged.error };
  }
  // A file already in the repo is adopted by pointing at it, so there is
  // nothing staged and nothing to move.
  if (!staged.staged) {
    for (const line of describeSpecOutcome({ ok: true, oasFile: staged.oasFile, outcome: 'pointed' })) {
      console.log(line);
    }
    return {
      kind: 'on-disk', endpoints: countOasEndpoints(path.join(rootDir, staged.oasFile)),
      targetFile: staged.oasFile, oasSource: staged.oasSource,
    };
  }
  return compareStaged({
    apiEntry, rootDir, stagedFile: staged.oasFile, oasSource: staged.oasSource,
  });
}

/**
 * Resolve "here is where my spec is" - a path, a URL, or a description - into a
 * staged (or pointed-at) spec. Shared by the interactive prompt and by
 * `--oas <file|url>` so a flag can't reach a different answer than a person.
 */
async function stageSpecFromInput({
  input, rootDir, packageDir = rootDir, apiEntry = {}, setSpinner = () => {}, onAmbiguous = null,
}) {
  if (/^https?:\/\//i.test(input)) {
    cleanRefreshTemp(rootDir);
    guardRefreshTemp(rootDir);
    const res = await fetchOasFromUrl({
      url: input, rootDir, destDir: path.join(rootDir, REFRESH_DIR), setSpinner,
    });
    if (!res.ok) {
      discardSpecChange(rootDir);
      return { ok: false, error: res.error, detail: res.detail };
    }
    return { ok: true, staged: true, oasFile: res.oasFile, oasSource: { kind: 'url', url: input } };
  }

  const absPath = path.isAbsolute(input) ? input : path.resolve(rootDir, input);
  if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
    // Inside the repo this only reads and returns their path; outside it, it
    // copies - so stage the copy rather than landing it on the live spec.
    cleanRefreshTemp(rootDir);
    guardRefreshTemp(rootDir);
    const res = adoptOasFile({ absPath, rootDir, destDir: path.join(rootDir, REFRESH_DIR) });
    if (!res.ok) {
      discardSpecChange(rootDir);
      return { ok: false, error: res.error, detail: res.detail };
    }
    if (res.outcome === 'pointed') {
      releaseRefreshTemp();
      return { ok: true, staged: false, oasFile: res.oasFile, oasSource: { kind: 'file', input } };
    }
    return { ok: true, staged: true, oasFile: res.oasFile, oasSource: { kind: 'file', input } };
  }

  const staged = await stageRefresh({
    // A description is a one-off instruction, not the recorded summary, so hand
    // `locate` an entry carrying it.
    apiEntry: { ...apiEntry, oasSource: { kind: 'describe', summary: input } },
    rootDir,
    packageDir,
    strategy: 'locate',
    setSpinner,
    onAmbiguous,
  });
  if (!staged.ok) return { ok: false, error: staged.error };
  return { ok: true, staged: true, oasFile: staged.oasFile, oasSource: staged.oasSource };
}

/**
 * Run one action. Returns a check-shaped result - the same shape the up-front
 * check produces - so the caller reports, confirms and applies identically
 * whichever way the refresh was asked for.
 */
export async function runAction({ action, apiEntry, rootDir, packageDir, setSpinner = () => {} }) {
  if (action === 'revalidate') {
    // Nothing is fetched or generated: the file already is the truth. The same
    // read the up-front check does, so an explicit re-check and an automatic
    // one can't disagree about whether the file moved - and so this can't
    // announce "your spec changed" about a file that didn't.
    return checkFileOnDisk({ rootDir, apiEntry });
  }

  if (action === 'adopt') {
    return stageFromPrompt({ rootDir, packageDir, apiEntry, setSpinner });
  }

  const strategy = ACTION_STRATEGY[action];
  if (!strategy) return { kind: 'failed', reason: `unknown action ${action}` };

  const staged = await stageRefresh({
    apiEntry, rootDir, packageDir, strategy, setSpinner, onAmbiguous: pickOasCandidate,
  });
  if (!staged.ok) return { kind: 'failed', reason: staged.error };
  return compareStaged({
    apiEntry,
    rootDir,
    stagedFile: staged.oasFile,
    oasSource: staged.oasSource,
    coverage: staged.coverage,
  });
}

/**
 * Run the recorded source's refresh with no questions asked, for `--refresh`.
 * The primary action is never `adopt`, so this can't reach a prompt: every
 * kind's default action is something we already know how to run.
 *
 * The flag is the consent, so a change is applied here rather than staged for
 * a confirm that will never come.
 */
export async function refreshFromRecordedSource({
  rootDir, packageDir, apiEntry, setSpinner = () => {},
}) {
  const primary = buildActions(apiEntry)[0];
  const check = await runAction({
    action: primary.key, apiEntry, rootDir, packageDir, setSpinner,
  });
  if (check.kind === 'failed') {
    return { ok: false, action: primary.key, error: check.reason };
  }
  const oasFile = applySpecChange({ rootDir, check });
  return {
    ok: true,
    action: primary.key,
    oasFile,
    oasSource: check.oasSource,
    endpoints: check.endpoints,
    // An unchanged spec has no diff; report it as nothing added or removed
    // rather than making every caller null-check.
    diff: check.diff || { added: [], removed: [], modified: [], changed: false },
    unchanged: check.kind === 'unchanged',
  };
}

/** Adopt a spec named on the command line: a path or a URL, no prompting. */
export async function adoptSpecFromArg({ rootDir, packageDir, apiEntry = {}, arg, setSpinner = () => {} }) {
  const staged = await stageSpecFromInput({
    input: arg, rootDir, packageDir, apiEntry, setSpinner,
  });
  if (!staged.ok) return staged;
  const check = staged.staged
    ? compareStaged({ apiEntry, rootDir, stagedFile: staged.oasFile, oasSource: staged.oasSource })
    : { kind: 'on-disk', targetFile: staged.oasFile, oasSource: staged.oasSource };
  if (check.kind === 'failed') return { ok: false, error: check.reason };
  return {
    ok: true,
    oasFile: applySpecChange({ rootDir, check }),
    oasSource: check.oasSource,
    endpoints: check.endpoints ?? null,
  };
}

/**
 * Record a refreshed spec on the entry. Shared by the interactive flow and the
 * flag-driven one so both stamp the same fields.
 */
export function recordSpec({ rootDir, apiEntry, oasFile, oasSource }) {
  const settings = loadSettings(rootDir);
  const entry = findApiEntry(settings, apiEntry);
  if (!entry) return false;
  entry.oasFile = oasFile;
  if (oasSource) entry.oasSource = oasSource;
  entry.lastSyncedAt = new Date().toISOString();
  saveSettings(rootDir, settings);
  return true;
}

/**
 * The interactive spec flow: pick an action, run it, show what it would do,
 * and only then write anything.
 *
 * Returns `{ changed, oasFile }` - `changed` says whether settings were
 * written, so the caller knows if there is anything to sync.
 */
export default async function updateOas({ rootDir, packageDir, apiEntry, setSpinner = () => {} }) {
  const currentCount = apiEntry.oasFile
    ? countOasEndpoints(path.join(rootDir, apiEntry.oasFile))
    : null;

  console.log('');
  console.log(`  ${bold('Spec')} ${apiEntry.oasFile ? cyan(apiEntry.oasFile) : dim('none yet')}`);
  console.log(
    `  ${dim(
      [
        describeOasSource(apiEntry.oasSource),
        currentCount === null ? null : `${currentCount} endpoint${currentCount === 1 ? '' : 's'}`,
      ].filter(Boolean).join(' · '),
    )}`,
  );

  const actions = buildActions(apiEntry);
  const picked = actions[
    await singleSelect(
      actions.map((a) => ({ label: a.label, hint: a.hint })),
      { message: 'How should we refresh it?', defaultIndex: 0 },
    )
  ];
  debug.log('update-oas.action', { action: picked.key, kind: apiEntry.oasSource?.kind || null });

  const check = await runAction({
    action: picked.key, apiEntry, rootDir, packageDir, setSpinner,
  });

  if (check.kind === 'failed') {
    console.log('');
    console.log(`  ${red('✗')} ${check.reason}.`);
    console.log(`  ${dim(`Your ${apiEntry.oasFile || 'spec'} is untouched.`)}`);
    return { changed: false };
  }

  if (check.kind === 'unchanged') {
    console.log('');
    console.log(`  ${dim(`No change. Still ${check.endpoints} endpoint${check.endpoints === 1 ? '' : 's'}.`)}`);
    return { changed: false };
  }

  console.log('');
  for (const line of describeCheck(check)) console.log(line);
  if (check.coverage) {
    console.log('');
    for (const line of describeCoverageGap(check.coverage)) console.log(line);
  }

  if (!await confirmSpecChange({ check, apiEntry })) {
    discardSpecChange(rootDir);
    console.log('');
    console.log(dim('  Left your spec and settings alone.'));
    return { changed: false };
  }

  const oasFile = applySpecChange({ rootDir, check });
  if (!recordSpec({ rootDir, apiEntry, oasFile, oasSource: check.oasSource })) {
    return { changed: false };
  }

  console.log('');
  console.log(`  ${green('✓')} ${bold(oasFile)} recorded in .restless/settings.json.`);
  if (oasFile !== apiEntry.oasFile) {
    console.log(`  ${dim(`Commit it - ${CLI_NAME} and the SDK both read this path.`)}`);
  }
  return { changed: true, oasFile };
}

/**
 * The one consent gate for a spec change, so both entry points ask the same
 * question and disclose the same consequences.
 *
 * Two things have to be said before someone can answer honestly:
 *
 *  - Removing endpoints from a published spec is the destructive direction:
 *    anything the docs and the MCP tools offered stops existing. Said
 *    unconditionally, because a run with no one watching still has to leave a
 *    record of what it dropped.
 *  - An accepted refresh may be recorded at a different path than the spec
 *    they have now (we never write over a file they maintain). That changes
 *    which file the SDK reads, so it is not a detail to discover afterwards.
 */
export async function confirmSpecChange({ check, apiEntry }) {
  const removed = check.diff?.removed?.length || 0;
  if (removed) {
    console.log('');
    console.log(
      `  ${yellow('!')} ${removed} endpoint${removed === 1 ? '' : 's'} would disappear from your docs and MCP tools.`,
    );
  }
  const retargeted = check.targetFile && apiEntry.oasFile && check.targetFile !== apiEntry.oasFile;
  if (retargeted) {
    console.log('');
    console.log(`  ${dim(`This will be recorded at ${bold(check.targetFile)}.`)}`);
    console.log(`  ${dim(`Your ${apiEntry.oasFile} is left exactly as it is.`)}`);
  }

  // Nobody to ask. A removal is the one case where silence is not consent, so
  // it stops; anything else proceeds, which is what a scripted run wants.
  if (!isInteractive()) return removed === 0;

  console.log('');
  return askYesNo(
    removed
      ? `  ${bold('Continue?')} ${dim('(y/N) ')}`
      : `  ${bold('Update the spec and sync your settings?')} ${dim('(Y/n) ')}`,
    { defaultValue: removed === 0 },
  );
}
