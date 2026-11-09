import {
  bold, dim, green, red, yellow, cyan,
  ask, askYesNo, singleSelect, actionPicker, waitForKey, printLogo, clearScreen, startSpinner,
} from '../lib/ui.js';
import { runAI, loadPrompt } from '../lib/ai.js';
import { loadSettings, saveSettings, validateApiField, REQUEST_PREFIX_RE } from '../lib/settings.js';
import { SITE_URL, CLI_NAME } from '../lib/config.js';
import { isInteractive } from '../lib/env.js';
import { oasSourceFacets, describeOasSource } from '../lib/oas-source.js';
import { getCliToken } from '../lib/cli-token.js';
import { syncProject } from '../lib/project-sync.js';
import { syncSpecBaseUrl, describeSpecBaseUrl } from '../lib/spec-base-url.js';
import updateOas, {
  applySpecChange,
  confirmSpecChange,
  discardSpecChange,
  inspectProject,
  recordSpec,
} from './update-oas.js';
import { describeCheck, describeDashboardGap, dashboardIsBehind } from './update-render.js';
import * as debug from '../lib/debug.js';

/**
 * `npx restless update` with a human at the keyboard.
 *
 * Lives here rather than inline in `bin/restless.js` because it is the same size and
 * shape as any other step, and it needs the same things they do: the shared
 * check, the shared renderer, the shared push. Left in the entry point it grew
 * a private copy of the push sequence and a hand-inlined per-kind predicate,
 * both of which had already drifted from the headless path's versions.
 *
 * `bin/restless.js` still owns choosing the project and deciding that a human is
 * present; everything after that is here.
 */

/**
 * Clear the viewport + scrollback and reprint the logo + "Editing X" header.
 * Called before every picker iteration so the screen doesn't accumulate stale
 * renders from previous edits + sub-prompts.
 */
function repaintHeader(apiEntry) {
  clearScreen();
  console.log('');
  printLogo();
  console.log('');
  console.log(`  ${bold('Editing')} ${cyan(apiEntry.name || apiEntry.rootDir || 'this project')}`);
  console.log(dim(`  ${apiEntry.projectId}`));
  console.log('');
}

/**
 * Publish whatever is now on disk. Returns a process exit code.
 *
 * The push itself is `syncProject`; this is only how it is narrated. A token we
 * can't get is a partial success, not a failure: the local edits are already
 * saved, and exiting non-zero would tell a script the change didn't happen.
 */
async function publish({ rootDir, apiEntry, oasFile = null, signal }) {
  const tokenRes = await getCliToken({ projectId: apiEntry.projectId, interactive: isInteractive() });
  if (signal?.aborted) {
    console.log(red('  Sync cancelled.'));
    return 130;
  }
  if (!tokenRes.ok) {
    console.log('');
    console.log(`  ${yellow('!')} Saved locally but not synced: ${tokenRes.error}`);
    console.log(dim(`  Re-run ${cyan(`npx ${CLI_NAME} update`)} to authorize and sync.`));
    console.log('');
    return 0;
  }

  console.log('');
  if (oasFile) console.log(dim(`  Pushing ${oasFile} to ${SITE_URL}...`));
  let pendingReported = false;
  const res = await syncProject({
    rootDir, apiEntry, oasFile, token: tokenRes.token, signal,
    onPending: () => {
      if (!pendingReported) console.log(dim('  Screening the spec before publication. This can take several minutes. Ctrl-C stops waiting.'));
      pendingReported = true;
    },
  });

  if (res.specSynced) {
    console.log(`  ${green('✓')} Spec synced${res.endpoints !== null ? dim(` (${res.endpoints} endpoints)`) : ''}.`);
  }
  if (!res.ok) {
    console.log(`  ${red('✗')} ${res.error}`);
    // Name what survived. "Sync failed" on a run that did push the spec sends
    // someone looking for a spec that is already there.
    if (oasFile && !res.specSynced) {
      console.log(dim(`  Your local ${oasFile} is saved - re-run to retry the push.`));
    }
    console.log('');
    return res.cancelled ? 130 : 1;
  }
  console.log(`  ${green('✓')} Settings synced.`);
  console.log('');
  return 0;
}

/**
 * The opening screen: what changed, locally and on the dashboard.
 *
 * Only for kinds with a source to go back to. The old opening was a menu whose
 * "Update OAS file" read as "regenerate with AI" no matter where the spec came
 * from, which is exactly wrong for a spec we didn't write.
 *
 * Returns what the caller should do next:
 *   { done: code }     everything asked for is finished
 *   { note: lines }    nothing conclusive; show these above the menu
 *   { editSettings }   the developer asked for the settings editor
 */
async function openingCheck({ rootDir, packageDir, apiEntry, signal }) {
  repaintHeader(apiEntry);
  const facets = oasSourceFacets(apiEntry.oasSource?.kind);

  // Name the file, then get on with it. How the spec is produced is our
  // problem, not something to narrate: for a described source it's a paragraph
  // about someone's build internals, and it tells them nothing they can act on.
  console.log(`  ${bold(apiEntry.oasFile)}`);
  console.log('');

  // Re-deriving through an agent can take tens of seconds - enough that a bare
  // "Checking..." reads as a hang. Set the expectation without describing the
  // mechanism.
  const spin = startSpinner(
    facets.needsAgent ? 'Getting the latest spec, this can take a moment' : 'Getting the latest spec',
  );
  let check;
  let dashboard;
  let authorized;
  try {
    ({ check, dashboard, authorized } = await inspectProject({ rootDir, packageDir, apiEntry }));
  } finally {
    spin.stop();
  }

  const gap = describeDashboardGap(dashboard);
  const behind = dashboardIsBehind(dashboard);

  // A spec change and a stale dashboard are settled by the same push, so they
  // belong in one decision rather than two rounds.
  if (check.kind === 'staged' || check.kind === 'on-disk') {
    console.log('');
    for (const line of describeCheck(check)) console.log(line);
    if (gap.length) {
      console.log('');
      for (const line of gap) console.log(line);
    }
    if (!await confirmSpecChange({ check, apiEntry })) {
      // Declined: drop the staged copy and carry on to the menu, where they can
      // edit settings or choose a different spec instead.
      discardSpecChange(rootDir);
      return { note: [] };
    }
    const oasFile = applySpecChange({ rootDir, check });
    recordSpec({ rootDir, apiEntry, oasFile, oasSource: check.oasSource });
    return { done: await publish({ rootDir, apiEntry, oasFile, signal }) };
  }

  // Nothing staged, so nothing to discard. Anything below is either "push what
  // you already have" or "there is nothing to do".
  if (behind) {
    // The case that started all of this. The local spec is exactly right and
    // nothing needs regenerating, but the dashboard is serving something older
    // - so the only thing outstanding is the push. Saying "your spec is
    // unchanged" here and stopping is what sent someone looking for a bug in
    // the diff.
    console.log('');
    for (const line of gap) console.log(line);
    // A check that failed is still worth saying while we have their attention;
    // this used to be swallowed whenever the dashboard had something to report.
    if (check.kind === 'failed') {
      console.log('');
      console.log(`  ${yellow('!')} Couldn't check your local spec: ${check.reason}`);
    }
    console.log('');
    console.log(`  ${dim(`Your local ${apiEntry.oasFile} is ${check.kind === 'failed' ? 'unchanged as far as we know' : 'already up to date'}.`)}`);
    console.log('');
    if (await askYesNo(`  ${bold('Push it to the dashboard?')} ${dim('(Y/n) ')}`, { defaultValue: true })) {
      return { done: await publish({ rootDir, apiEntry, oasFile: apiEntry.oasFile, signal }) };
    }
    return { note: [] };
  }

  if (check.kind === 'unchanged') {
    // Nothing to do, so end here rather than dropping into a menu nobody asked
    // for. The exit is explicit: an unprompted `waitForKey()` is
    // indistinguishable from a hang, which is how this read before.
    //
    // Settings keep an escape hatch, because `update` edits those too and an
    // unchanged spec is the common case - exiting outright would make the
    // settings editor unreachable exactly when you'd normally reach it.
    console.log('');
    console.log(`  ${green('✓')} Your spec is unchanged ${dim(`(${check.endpoints} endpoints)`)}.`);
    console.log(authorized
      ? `  ${green('✓')} Your dashboard is serving this version.`
      : dim("  Not compared with the dashboard - this machine isn't authorized yet."));
    console.log('');
    console.log(`  ${dim('Press')} ${bold('Enter')} ${dim('to exit, or')} ${bold('s')} ${dim('to edit settings.')}`);
    const key = await waitForKey();
    if (key !== 's' && key !== 'S') {
      console.log('');
      return { done: 0 };
    }
    // Straight to the field editor: they named what they wanted, so making them
    // pick it out of a menu first would be a wasted screen.
    return { editSettings: true };
  }

  if (check.kind === 'unknown') {
    return {
      note: [
        `  ${dim(`${apiEntry.oasFile} has ${check.endpoints} endpoints.`)}`,
        dim("  Can't compare with the dashboard until this machine is authorized."),
      ],
    };
  }

  return {
    note: [
      `  ${yellow('!')} Couldn't check your spec: ${check.reason}`,
      dim('  You can still edit settings or point us at another spec.'),
    ],
  };
}

/** Best-effort extraction of a single JSON object from a model response.
 *  Tolerates ```json fences, leading prose, trailing prose. */
function parseJsonBlock(text) {
  if (typeof text !== 'string') return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

function displayValue(value) {
  if (value === undefined || value === null || value === '') return dim('-');
  return String(value);
}

/**
 * AI-driven edit path. The user types a sentence; we ship the editable subset
 * of settings + their message to the provider and expect a JSON patch back.
 * The patch is validated against the same rules the flags and the inline editor
 * use, diffed, and only applied after an explicit y/n.
 */
async function chatEdit({ rootDir, settings, apiEntry }) {
  console.log('');
  const msg = (await ask(
    `  ${bold('What do you want to change?')} ${dim('(blank to cancel)')}\n  > `,
  )).trim();
  if (!msg) return;

  const pause = async (lines) => {
    console.log('');
    for (const line of lines) console.log(line);
    console.log(dim('  Press any key to continue.'));
    await waitForKey();
  };

  const view = {
    name: apiEntry.name ?? null,
    baseUrl: apiEntry.baseUrl ?? null,
    internal: apiEntry.internal === true,
    requestIdPrefix: apiEntry.requestIdPrefix ?? null,
  };

  let raw;
  try {
    raw = await runAI(loadPrompt('update-settings-chat', {
      currentSettings: JSON.stringify(view, null, 2),
      userMessage: msg,
    }), rootDir, { label: 'update-settings-chat' });
  } catch (err) {
    return pause([red(`  ✗ Couldn't reach the AI: ${err.message}`)]);
  }

  const parsed = parseJsonBlock(raw);
  if (!parsed) return pause([red(`  ✗ The AI didn't return a JSON patch. Try rephrasing.`)]);
  if (parsed.error) return pause([yellow(`  ! ${parsed.error}`)]);

  const changes = parsed.changes && typeof parsed.changes === 'object' ? parsed.changes : {};
  const violations = Object.entries(changes)
    .map(([k, v]) => validateApiField(k, v))
    .filter(Boolean);
  if (violations.length) {
    return pause([red(`  ✗ Proposed change is invalid:`), ...violations.map((v) => red(`    · ${v}`))]);
  }

  const keys = Object.keys(changes);
  if (keys.length === 0) {
    return pause([yellow(`  ! No changes proposed. ${parsed.summary || ''}`)]);
  }

  console.log('');
  if (parsed.summary) console.log(`  ${bold(parsed.summary)}`);
  console.log('');
  for (const k of keys) {
    console.log(`    ${dim(k.padEnd(16))} ${displayValue(apiEntry[k])}  ${green('→')}  ${green(displayValue(changes[k]))}`);
  }
  console.log('');
  if (!await askYesNo(`  Apply these changes? ${dim('(Y/n) ')}`, { defaultValue: true })) {
    return pause([dim('  Skipped.')]);
  }

  for (const k of keys) apiEntry[k] = changes[k];
  saveSettings(rootDir, settings);
}

/**
 * The field editor. Each picker row is a field with its current value;
 * navigating to one and pressing Enter opens an inline editor. Submit ends the
 * loop and continues to the sync.
 */
async function editSettings({ rootDir, apiEntry: chosenApi, signal }) {
  // Re-find the entry inside a loaded settings object so mutations propagate
  // into the structure we save.
  const settings = loadSettings(rootDir);
  const apiEntry = settings.apis.find((a) => a.projectId === chosenApi.projectId);
  if (!apiEntry) {
    console.log('');
    console.log(red('  ✗ That API is no longer in .restless/settings.json.'));
    return 1;
  }

  // Opening the Base URL field counts even if the value is kept: confirming it
  // is how someone repairs a spec that never picked up an earlier change.
  const startingBaseUrl = apiEntry.baseUrl;
  let baseUrlTouched = false;
  let lastIndex = 0;
  for (;;) {
    repaintHeader(chosenApi);
    const result = await actionPicker(
      [
        { label: 'Name', value: apiEntry.name },
        { label: 'Base URL', value: apiEntry.baseUrl },
        // generate-oas writes either `internal: true` (internal API) or
        // `internal: false` / unset (external/customer-facing).
        { label: 'Visibility', value: apiEntry.internal === true ? 'Internal' : 'External' },
        { label: 'Request prefix', value: apiEntry.requestIdPrefix },
      ],
      {
        message: 'Use ↑↓ to navigate, Enter to edit, Esc to exit:',
        actions: [
          { key: 'submit', label: 'Submit', hint: 'Save & sync to the dashboard.', primary: true },
          { key: 'chat', label: 'Chat about this', afterthought: true },
        ],
        defaultIndex: lastIndex,
      },
    );

    if (result.kind === 'action') {
      if (result.key === 'submit') break;
      if (result.key === 'chat') {
        await chatEdit({ rootDir, settings, apiEntry });
        // Park the cursor on Chat for follow-up edits. Indices: 0-3 are
        // fields, 4 is Submit, 5 is Chat.
        lastIndex = 5;
        continue;
      }
    }

    lastIndex = result.index;
    if (result.index === 0) {
      const next = (await ask(`  ${bold('Name')}: `, { defaultValue: apiEntry.name || '' })).trim();
      if (next && next !== apiEntry.name) apiEntry.name = next;
    } else if (result.index === 1) {
      baseUrlTouched = true;
      const next = (await ask(`  ${bold('Base URL')}: `, { defaultValue: apiEntry.baseUrl || '' })).trim();
      const err = next ? validateApiField('baseUrl', next) : null;
      if (err) console.log(red(`  ✗ ${err}`));
      else if (next && next !== apiEntry.baseUrl) apiEntry.baseUrl = next;
    } else if (result.index === 2) {
      const visIdx = await singleSelect(
        [
          { label: 'External', hint: 'Customer-facing - appears on the public docs.' },
          { label: 'Internal', hint: 'Admin-only - hidden from the public docs.' },
        ],
        { message: 'Visibility', defaultIndex: apiEntry.internal === true ? 1 : 0 },
      );
      apiEntry.internal = visIdx === 1;
    } else if (result.index === 3) {
      const next = (await ask(
        `  ${bold('Request prefix')} ${dim('(1-7 letters/digits)')}: `,
        { defaultValue: apiEntry.requestIdPrefix || '' },
      )).trim().toUpperCase();
      if (next && !REQUEST_PREFIX_RE.test(next)) {
        console.log(red(`  ✗ Prefix must be 1-7 uppercase letters or digits (e.g. TST).`));
      } else if (next && next !== apiEntry.requestIdPrefix) {
        apiEntry.requestIdPrefix = next;
      }
    }

    // Persist after every successful edit so a Ctrl-C mid-flow doesn't throw
    // away changes the user already confirmed.
    saveSettings(rootDir, settings);
  }

  // The dashboard's docs, try-it and MCP calls read the spec's servers, not
  // this setting, so a base URL change has to land in the spec and be pushed.
  // The chat editor can change it too, hence comparing as well as `touched`.
  let oasFile = null;
  if (apiEntry.baseUrl && (baseUrlTouched || apiEntry.baseUrl !== startingBaseUrl)) {
    const servers = syncSpecBaseUrl({ rootDir, apiEntry, baseUrl: apiEntry.baseUrl });
    debug.log('update.spec-servers', { outcome: servers.outcome });
    const lines = describeSpecBaseUrl(servers);
    if (lines.length) console.log('');
    for (const line of lines) console.log(line);
    if (servers.push) oasFile = servers.oasFile;
  }

  return publish({ rootDir, apiEntry: chosenApi, oasFile, signal });
}

/**
 * Run the interactive update. Returns the process exit code.
 */
export default async function runInteractiveUpdate({ rootDir, packageDir, apiEntry, signal }) {
  let note = [];
  let straightToSettings = false;

  // Only kinds with a source to go back to can be checked before we ask
  // anything; the rest need an explicit decision, which the menu below is.
  if (apiEntry.oasFile && oasSourceFacets(apiEntry.oasSource?.kind).autoCheck) {
    const opened = await openingCheck({ rootDir, packageDir, apiEntry, signal });
    if (opened.done !== undefined) return opened.done;
    if (opened.editSettings) straightToSettings = true;
    note = opened.note || [];
  }

  if (!straightToSettings) {
    repaintHeader(apiEntry);
    for (const line of note) console.log(line);
    if (note.length) console.log('');

    // Two choices only - everything `update` does is either editing settings or
    // changing the spec. Ctrl-C or Esc bails at any prompt; there's no explicit
    // "cancel" option.
    const topChoice = await singleSelect(
      [
        { label: 'Update Settings', hint: 'Edit name, base URL, visibility, or request prefix' },
        {
          label: 'Change the spec',
          hint: apiEntry.oasSource
            ? `Currently ${describeOasSource(apiEntry.oasSource)}`
            : 'Re-scan your routes, or point us at a spec',
        },
      ],
      { message: 'What do you want to update?', defaultIndex: 0 },
    );

    if (topChoice === 1) {
      // Everything about what "refresh" means is decided from the recorded
      // `oasSource`, inside the step. Here we only push the result once the
      // developer has agreed to it.
      const res = await updateOas({ rootDir, packageDir, apiEntry });
      if (!res.changed) {
        console.log('');
        return 0;
      }
      return publish({ rootDir, apiEntry, oasFile: res.oasFile, signal });
    }
  }

  debug.log('update.edit-settings', { projectId: apiEntry.projectId });
  return editSettings({ rootDir, apiEntry, signal });
}
