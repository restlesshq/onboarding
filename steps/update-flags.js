import path from 'path';
import { bold, dim, green, red, yellow, cyan } from '../lib/ui.js';
import { loadSettings, saveSettings, validateApiField, findApiEntry } from '../lib/settings.js';
import { CLI_NAME } from '../lib/config.js';
import { readFlag } from '../lib/args.js';
import { getCliToken } from '../lib/cli-token.js';
import { syncProject } from '../lib/project-sync.js';
import { syncSpecBaseUrl, describeSpecBaseUrl } from '../lib/spec-base-url.js';
import { countOasEndpoints, describeOasSource, oasSourceFacets } from '../lib/oas-source.js';
import {
  adoptSpecFromArg,
  cleanRefreshTemp,
  inspectProject,
  recordSpec,
  refreshFromRecordedSource,
} from './update-oas.js';
import { describeCheck, describeDashboardGap } from './update-render.js';
import * as debug from '../lib/debug.js';

/**
 * `npx restless update` driven by flags instead of pickers.
 *
 * `init` grew an agent-aware path a while ago; `update` had none, so a coding
 * agent that wanted to change a base URL or re-sync a spec landed in a
 * full-screen TTY picker it could not drive. This is that path, and nothing in
 * this file may prompt.
 *
 * Everything here goes through the same helpers the interactive flow uses -
 * `validateApiField` for the settings fields, `inspectProject` and
 * `refreshFromRecordedSource` for the spec, `syncProject` to push - so a flag
 * can't accept something the editor would reject, and a headless run can't
 * reach a different answer than a human would.
 */

/**
 * Read the flag values off argv.
 *
 * Returns `{ flags }` when a directive was given, `{ flags: null }` when none
 * was (so the caller runs the interactive flow), or `{ errors }` when a flag
 * was given wrongly.
 *
 * That last case matters more than it looks: a value flag with nothing after it
 * used to be indistinguishable from not passing it, so `npx restless update
 * --base-url` (a typo, or a shell that ate the argument) silently did nothing
 * and reported success. An agent has no way to notice that.
 */
export function parseUpdateFlags(argv) {
  const errors = [];
  const read = (flag) => {
    const { present, value } = readFlag(argv, flag);
    if (present && value === null) errors.push(`${flag} needs a value.`);
    return value;
  };

  const edits = {};
  const name = read('--name');
  if (name !== null) edits.name = name;
  const baseUrl = read('--base-url');
  if (baseUrl !== null) edits.baseUrl = baseUrl;
  const prefix = read('--prefix');
  if (prefix !== null) edits.requestIdPrefix = prefix.toUpperCase();
  if (argv.includes('--internal') && argv.includes('--external')) {
    errors.push('--internal and --external contradict each other.');
  } else if (argv.includes('--internal')) edits.internal = true;
  else if (argv.includes('--external')) edits.internal = false;

  const oas = read('--oas');
  const flags = {
    edits,
    oas,
    refresh: argv.includes('--refresh'),
    sync: argv.includes('--sync'),
    status: argv.includes('--status'),
    json: argv.includes('--json'),
  };

  if (oas && flags.refresh) {
    errors.push('--oas names a spec and --refresh re-runs the recorded one; pick one.');
  }
  if (errors.length) return { errors };

  const directed = Object.keys(edits).length > 0
    || flags.oas || flags.refresh || flags.sync || flags.status;
  return { flags: directed ? flags : null };
}

/**
 * Emit the result. `lines` is the human rendering, ANSI codes and all - it has
 * no business in a payload something else is going to parse.
 */
function report({ json, ok, lines = [], ...rest }) {
  if (json) {
    console.log(JSON.stringify({ ok, ...rest }, null, 2));
    return;
  }
  console.log('');
  for (const line of lines) console.log(line);
  console.log('');
}

/** The dashboard half of a result, as JSON. Derived from the comparison rather
 *  than flattened and rebuilt - the renderer takes the comparison itself. */
function dashboardJson(cmp) {
  if (cmp.status === 'unauthorized' || cmp.status === 'unavailable') {
    return { status: cmp.status, behind: null, reason: cmp.reason };
  }
  return {
    status: cmp.status,
    behind: cmp.status !== 'in-sync',
    endpoints: cmp.endpoints ?? 0,
    missing: cmp.missing || [],
    extra: cmp.extra || [],
    oasSyncedAt: cmp.oasSyncedAt ?? null,
  };
}

/** One vocabulary for the reported status, derived from the check's kind. */
const STATUS_FOR_KIND = {
  staged: 'changed',
  'on-disk': 'changed',
  unchanged: 'unchanged',
  unknown: 'unknown',
  failed: 'failed',
};

/**
 * `--status`: report the spec's state and whether it changed, writing nothing
 * and pushing nothing.
 *
 * Read-only by contract: a staged check downloads to a scratch directory and
 * deletes it again, and nothing here can reach the developer's spec.
 *
 * Narrower than the interactive check on purpose. The interactive flow also
 * re-derives `describe` and `native` specs, which means running an agent - fine
 * with a human watching a spinner who can interrupt it, wrong for the cheap
 * probe an agent calls before deciding anything. Those report
 * `checkable: false` here and point at `--refresh`, which is the explicit "yes,
 * do the expensive thing" request.
 */
export async function reportStatus({ rootDir, apiEntry, json }) {
  const facets = oasSourceFacets(apiEntry.oasSource?.kind);
  const checkable = facets.autoCheck && !facets.needsAgent;
  const out = {
    projectId: apiEntry.projectId,
    name: apiEntry.name,
    oasFile: apiEntry.oasFile || null,
    oasSource: apiEntry.oasSource || null,
    specChanged: null,
    checkable,
  };

  if (!apiEntry.oasFile) {
    report({ json, ok: true, ...out, status: 'no-spec', lines: [dim('  No spec recorded for this API yet.')] });
    return 0;
  }

  // The dashboard half runs either way; only the local check is gated on
  // whether answering it would spawn an agent.
  const { check, dashboard } = await inspectProject({
    rootDir, apiEntry, checkSpec: checkable,
  });
  cleanRefreshTemp(rootDir);
  out.dashboard = dashboardJson(dashboard);

  const lines = [`  ${bold(apiEntry.oasFile)} ${dim(`(${describeOasSource(apiEntry.oasSource)})`)}`];
  lines.push(...describeDashboardGap(dashboard));

  if (!checkable) {
    out.status = 'not-checkable';
    out.endpoints = countOasEndpoints(path.join(rootDir, apiEntry.oasFile));
    report({
      json, ok: true, ...out,
      lines: [
        ...lines,
        dim(`  ${out.endpoints} endpoints. Re-deriving this spec runs an agent over your code, so it isn't checked automatically.`),
        dim(`  Run \`npx ${CLI_NAME} update --refresh\` to do it.`),
      ],
    });
    return 0;
  }

  out.status = STATUS_FOR_KIND[check.kind] || check.kind;
  out.endpoints = check.endpoints ?? null;
  out.specChanged = out.status === 'changed' ? true : out.status === 'unchanged' ? false : null;
  if (check.diff) {
    out.added = check.diff.added;
    out.removed = check.diff.removed;
  }
  if (check.reason) out.reason = check.reason;

  lines.push(...describeCheck(check));
  if (out.specChanged) {
    lines.push(dim(`  Run \`npx ${CLI_NAME} update --refresh\` to apply and push it.`));
  }
  report({ json, ok: true, ...out, lines });
  return 0;
}

/**
 * Run a flag-driven update. Returns the process exit code.
 *
 * Local edits are applied and saved before anything is pushed, so a failure to
 * reach the dashboard never loses them - and the result says which of the two
 * happened rather than collapsing both into "failed".
 */
export default async function runFlagUpdate({ rootDir, packageDir, apiEntry, flags, signal }) {
  const { json } = flags;

  // Read-only, and deliberately first: `--status` must work with no
  // authorization, no network write, and nothing on disk changed.
  if (flags.status) return reportStatus({ rootDir, apiEntry, json });

  const lines = [];
  const out = { projectId: apiEntry.projectId, edited: [], synced: false, specSynced: false };

  // ── Validate every field before writing any of them ───────────────
  const violations = Object.entries(flags.edits)
    .map(([k, v]) => validateApiField(k, v))
    .filter(Boolean);
  if (violations.length) {
    report({
      json, ok: false, ...out, errors: violations,
      lines: [red(`  ✗ Invalid values:`), ...violations.map((v) => red(`    · ${v}`))],
    });
    return 1;
  }

  // ── Settings fields ───────────────────────────────────────────────
  if (Object.keys(flags.edits).length) {
    const settings = loadSettings(rootDir);
    const entry = findApiEntry(settings, apiEntry);
    if (!entry) {
      report({
        json, ok: false, ...out, error: 'API entry disappeared',
        lines: [red('  ✗ API entry not found.')],
      });
      return 1;
    }
    for (const [k, v] of Object.entries(flags.edits)) {
      if (entry[k] !== v) {
        entry[k] = v;
        out.edited.push(k);
      }
    }
    saveSettings(rootDir, settings);
    lines.push(out.edited.length
      ? `  ${green('✓')} Updated ${out.edited.join(', ')}.`
      : `  ${dim('No settings changed - the values given already matched.')}`);
  }

  // ── Spec ──────────────────────────────────────────────────────────
  // `--oas` names a new spec; `--refresh` re-runs whatever produced the current
  // one. Both stage first and only land the file once it has parsed.
  let specFile = null;
  if (flags.oas) {
    const adopted = await adoptSpecFromArg({ rootDir, packageDir, apiEntry, arg: flags.oas });
    if (!adopted.ok) {
      report({
        json, ok: false, ...out,
        // The specific reason, not a generic one. This used to be swallowed by
        // output suppression, leaving `--json` callers - the audience that most
        // needs it - with "couldn't use that as a spec" and nothing else.
        error: adopted.error,
        detail: adopted.detail ?? null,
        lines: [
          red(`  ✗ Couldn't use ${bold(flags.oas)} as an OpenAPI spec.`),
          red(`    ${adopted.error}`),
          ...(adopted.detail ? [dim(`    ${adopted.detail}`)] : []),
        ],
      });
      return 1;
    }
    recordSpec({ rootDir, apiEntry, oasFile: adopted.oasFile, oasSource: adopted.oasSource });
    specFile = adopted.oasFile;
    out.oasFile = specFile;
    lines.push(`  ${green('✓')} Spec is now ${bold(specFile)}.`);
  } else if (flags.refresh) {
    const refreshed = await refreshFromRecordedSource({ rootDir, packageDir, apiEntry });
    out.action = refreshed.action;
    if (!refreshed.ok) {
      report({
        json, ok: false, ...out, error: refreshed.error,
        lines: [
          red(`  ✗ Refresh (${refreshed.action}) didn't produce a spec: ${refreshed.error}`),
          dim('  Your existing spec is untouched.'),
        ],
      });
      return 1;
    }
    recordSpec({ rootDir, apiEntry, oasFile: refreshed.oasFile, oasSource: refreshed.oasSource });
    specFile = refreshed.oasFile;
    out.oasFile = specFile;
    out.endpoints = refreshed.endpoints;
    out.added = refreshed.diff.added;
    out.removed = refreshed.diff.removed;
    out.specChanged = !refreshed.unchanged;
    lines.push(refreshed.unchanged
      ? `  ${dim(`${specFile} is unchanged (${refreshed.endpoints} endpoints).`)}`
      : `  ${green('✓')} Refreshed ${bold(specFile)} ${dim(`(${refreshed.endpoints} endpoints)`)}.`);
    if (refreshed.diff.added.length) lines.push(`  ${green('+')} ${refreshed.diff.added.length} added`);
    // Never silent: a flag-driven run has no one watching, so a removal has to
    // appear in the output and in the JSON.
    if (refreshed.diff.removed.length) {
      const n = refreshed.diff.removed.length;
      lines.push(
        `  ${yellow('!')} ${n} endpoint${n === 1 ? '' : 's'} removed from your docs:`,
        ...refreshed.diff.removed.slice(0, 10).map((op) => `      ${dim(op)}`),
      );
    }
  }

  // ── Base URL into the spec ────────────────────────────────────────
  // After the spec step, so it applies to whichever spec the project now has.
  // Runs whenever --base-url is given, even if settings already matched: a
  // project left with the right setting and a stale spec is repaired by
  // repeating the command. Re-read the entry: the edits above and recordSpec
  // both wrote to disk, not to the `apiEntry` we were handed.
  if ('baseUrl' in flags.edits) {
    const current = findApiEntry(loadSettings(rootDir), apiEntry) || apiEntry;
    const servers = syncSpecBaseUrl({ rootDir, apiEntry: current, baseUrl: current.baseUrl });
    out.specServers = servers.outcome;
    if (servers.push) specFile = servers.oasFile;
    lines.push(...describeSpecBaseUrl(servers));
  }

  debug.log('update.flags', { edited: out.edited, spec: !!specFile, sync: flags.sync });

  // ── Push ──────────────────────────────────────────────────────────
  // A cached token only. Approving a new one needs a browser, and blocking a
  // scripted run on that for ten minutes is worse than reporting that the
  // local edits landed and the sync didn't.
  const tokenRes = await getCliToken({ projectId: apiEntry.projectId, interactive: false });
  if (signal?.aborted) {
    report({ json, ok: false, ...out, cancelled: true, error: 'Sync cancelled.', lines: [red('  Sync cancelled.')] });
    return 130;
  }
  if (!tokenRes.ok) {
    out.error = tokenRes.error;
    lines.push(
      `  ${yellow('!')} Saved locally, not synced: ${tokenRes.error}`,
      dim(`  Run ${cyan(`npx ${CLI_NAME} update`)} in a terminal once to authorize this machine.`),
    );
    // Exit 0: the edits applied. A non-zero code here would read as "the change
    // failed", which is wrong and would break scripted callers.
    report({ json, ok: true, ...out, lines });
    return 0;
  }

  let pendingReported = false;
  const res = await syncProject({
    rootDir, apiEntry, oasFile: specFile, token: tokenRes.token,
    signal,
    onPending: () => {
      if (!json && !pendingReported) console.log(dim('  Screening the spec before publication. This can take several minutes. Ctrl-C stops waiting.'));
      pendingReported = true;
    },
  });
  out.specSynced = res.specSynced;
  out.synced = res.settingsSynced;
  if (res.specSynced) {
    lines.push(`  ${green('✓')} Spec synced${res.endpoints !== null ? dim(` (${res.endpoints} endpoints)`) : ''}.`);
  }
  if (!res.ok) {
    out.error = res.error;
    if (res.pending) Object.assign(out, { pending: true, screening_id: res.screening_id, retry_after_ms: res.retry_after_ms });
    if (res.cancelled) out.cancelled = true;
    lines.push(`  ${red('✗')} ${res.error}`);
    report({ json, ok: false, ...out, lines });
    return res.cancelled ? 130 : 1;
  }
  lines.push(`  ${green('✓')} Settings synced.`);

  report({ json, ok: true, ...out, lines });
  return 0;
}

/** The flag list, for `--help` and the agent-facing docs. */
export const UPDATE_FLAGS = [
  ['--status', "Report whether your spec changed. Writes nothing, pushes nothing"],
  ['--name <n>', 'Rename the API on the dashboard'],
  ['--base-url <u>', "Set the API's production base URL (and a generated spec's servers)"],
  ['--internal / --external', 'Hide from or show on the public docs'],
  ['--prefix <P>', 'Set the request-ID prefix (1-7 letters/digits)'],
  ['--oas <file|url>', 'Point at a different spec and push it'],
  ['--refresh', 'Re-run whatever produced the current spec, then push it'],
  ['--sync', 'Push the current settings with no edits'],
  ['--project <id>', 'Pick one API in a multi-API repo'],
  ['--json', 'Print the result as JSON'],
];
