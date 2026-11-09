import {
  bold, dim, cyan, green, red, yellow, white, muted, askYesNo, startSpinner,
} from '../lib/ui.js';
import { runAI, loadPrompt, getProvider } from '../lib/ai.js';
import { extractJson } from '../lib/extract-json.js';
import { CLI_NAME } from '../lib/config.js';
import { isInteractive } from '../lib/env.js';
import { describeRepo, changedSince, hasUncommittedChanges } from '../lib/context-repo.js';
import { screenCandidates, contextModels } from '../lib/context-guard.js';
import { fetchScope, pushCandidates } from '../lib/context-sync.js';
import { buildPlan } from '../lib/context-plan.js';
import { loadSettings, findApiEntry } from '../lib/settings.js';
import { detectStack } from '../lib/detect-stack.js';

/**
 * `npx restless context` - read this repo, propose what the AI should know
 * about the API, and put it in the dashboard's inbox for review.
 *
 * The shape of the whole thing, because it is the part worth getting right:
 *
 *   1. Sign in (the caller does this) and pick a project.
 *   2. Ask the project what it already knows, and when it last read THIS repo.
 *   3. Extract, here, in the developer's own agent. The repository never
 *      leaves the machine.
 *   4. Second pass: a fresh model call that sees only the extracted text, plus
 *      a set of deterministic rules. Anything either one flags is dropped and
 *      named on the terminal, so the developer can see the pass working
 *      without the offending text going anywhere.
 *   5. Show what survived, ask, upload. The server runs its own adversarial
 *      review before anything is stored, and everything lands as pending.
 *
 * Re-running is the normal case, not the exception. A second run diffs against
 * the commit the last one recorded and only reads what changed, which is why
 * the whole thing is cheap enough to put in a habit or a CI job.
 */

const MAX_CANDIDATES = 60;
// Enough files to describe a real change set without turning the prompt into
// the repository. Past this we stop pretending it is an incremental run.
const MAX_CHANGED_FILES = 60;

/** Ceiling per batch. The run-wide `MAX_CANDIDATES` still applies after. */
const MAX_CANDIDATES_PER_BATCH = 12;

// Turn budget for one batch.
//
// The provider's default of 30 is sized for a focused task, and reading a
// whole repository is not one: the first real run in `restlesshq/app` spent 27
// Reads and 2 Globs orienting itself, hit the cap, and returned nothing.
// Hitting the cap is not a degraded result, it is NO result, because the agent
// never reaches the turn where it emits its answer.
//
// Batching is what makes this number small and safe again. A batch is a known
// list of files (7 by default), so the budget is one read each plus room to
// follow an import and answer - not an open-ended exploration whose cost
// nobody can predict.
const MAX_TURNS_PER_BATCH = 25;
// The redaction pass reads no files at all - it gets the candidates inline and
// is told not to go looking - so it needs only enough turns to think and
// answer.
const MAX_TURNS_REVIEW = 10;

/**
 * The scope paragraph for one batch.
 *
 * Every batch names its own files. Nothing here ever says "read the
 * repository": working out which files matter is the planner's job, done
 * deterministically before any model runs, because that is the question the
 * first real run spent its entire turn budget failing to answer.
 */
function describeBatchScope({ batch, plan, mode, lastRun, label, kind }) {
  const lines = [];
  const isCrossCutting = kind === 'shared';

  if (kind === 'product') {
    lines.push(
      "This pass is about what the product IS, not how any one endpoint behaves. These are the repo's own prose files: the README, the docs, the guides.",
      '',
      'Pull out what a newcomer needs before they can use anything: what this API is for, what each capability does and why someone would reach for it, what the nouns mean (what IS a log, a project, a use case here), how the pieces relate, and what a caller has to do first.',
      '',
      'This is the flavour of context the code passes cannot produce, so it is worth being generous here.',
      '',
      "**A repo's docs folder is usually half customer documentation and half the team's own notes, and only the first half is in scope.** Before extracting anything from a file, decide who it was written for. If it is about how the service is operated, deployed, scaled or stored (databases, caches, queues, infrastructure, query tuning, runbooks), or about contributing, releasing, or running the project locally, it was written for the team. **Skip that file entirely and move on.** Its contents are internal even though nobody labelled them so.",
      '',
      'Files:',
    );
  } else if (isCrossCutting) {
    lines.push(
      'This pass is about the things that apply **across** the API rather than to one endpoint: how authentication works, how paging works, what an error body looks like, what the limits are, what has to happen in what order.',
      '',
      'These files were picked because their names suggest they hold that kind of rule:',
    );
  } else if (mode === 'incremental') {
    lines.push(
      `This is an **incremental pass**. ${label} was last indexed at commit \`${lastRun.headSha.slice(0, 8)}\`${lastRun.ranAt ? ` on ${new Date(lastRun.ranAt).toLocaleDateString()}` : ''}, and only these files have changed since:`,
    );
  } else {
    lines.push(
      plan.specSource === 'none'
        ? 'These files were located by a scan of the repository as the ones that define its HTTP surface:'
        : "These files serve part of the API's published surface, matched from its OpenAPI spec:",
    );
  }

  lines.push('', batch.files.map((f) => `- ${f}`).join('\n'));

  if (batch.operations.length) {
    lines.push(
      '',
      'The operations these files serve, which is what a reader of the docs will actually be calling:',
      '',
      batch.operations.map((o) => `- ${o}`).join('\n'),
    );
  }

  if (mode === 'incremental') {
    lines.push(
      '',
      'Propose something only if these changes actually created or corrected a fact a developer needs. A refactor that moved code without changing the API is a legitimate empty result. Return `[]` rather than padding.',
    );
  }

  return lines.join('\n');
}

/**
 * Which endpoint scanners to run here.
 *
 * `setupLanguages` is what `detectStack` believes this repo is written in.
 * JavaScript is always included: `detectStack` reports it via `nodeEvidence`
 * rather than in the language list, and a repo that turns out to be Python
 * with a Node frontend still has routes worth finding on both sides. Scanning
 * for a language that isn't there costs a directory walk that finds nothing.
 */
function detectLanguages(cwd) {
  try {
    const stack = detectStack(cwd);
    return [...new Set(['javascript', ...(stack.setupLanguages || [])])];
  } catch {
    return ['javascript'];
  }
}

/**
 * The spec `init` wrote in this repo, if there is one.
 *
 * Preferred over the project's server-side copy: it is the spec as it exists
 * at the commit being read, so a run right after an API change plans against
 * the new shape rather than whatever was last uploaded.
 */
function localOasFileFor(cwd, projectId) {
  try {
    const settings = loadSettings(cwd);
    // Match the project being uploaded to first: a workspace with two APIs in
    // it has two specs, and the wrong one would plan against the wrong API.
    const entry = findApiEntry(settings, { projectId }) || settings.apis?.[0];
    return entry?.oasFile || '';
  } catch {
    return '';
  }
}

/** Compact list of what the project already has, for the "don't repeat" list. */
function describeExisting(existing) {
  const context = existing?.context ?? [];
  const usecases = existing?.usecases ?? [];
  if (!context.length && !usecases.length) {
    return 'Nothing saved yet. This project has no context and no use cases.';
  }
  const lines = [];
  if (context.length) {
    lines.push('Context items:');
    lines.push(...context.map((c) => `- ${c.title}`));
  }
  if (usecases.length) {
    if (lines.length) lines.push('');
    lines.push('Use cases:');
    lines.push(...usecases.map((c) => `- ${c.title}`));
  }
  return lines.join('\n');
}

/** Content words of a title, for comparing two of them. */
function titleTokens(title) {
  const STOP = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'by', 'for', 'from', 'in', 'is', 'it',
    'of', 'on', 'or', 'the', 'to', 'with', 'every', 'each', 'all', 'its', 'this',
    'that', 'when', 'what', 'how', 'api', 'endpoint', 'endpoints', 'request',
    'requests', 'response', 'responses',
  ]);
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      // Crude stemming, enough to make "refuses"/"refuse" and "keys"/"key" meet.
      .map((w) => w.replace(/(ies)$/, 'y').replace(/(es|s)$/, '')),
  );
}

/** Jaccard overlap of two token sets. */
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Collapse near-duplicates from different passes.
 *
 * Several passes legitimately arrive at the same fact: the route file says a
 * read-only key is refused, so does the auth helper the cross-cutting pass
 * read, so does the README. A first version compared titles exactly and let
 * four wordings of "read-only keys refuse writes" through, which is a bad
 * preview and four rows for a reviewer to reject one at a time.
 *
 * Titles only, and by overlap rather than equality, because the wordings
 * differ by exactly the filler words a title uses. This is a rough pass on the
 * developer's machine, not the real gate: the server still dedupes by
 * embedding against the whole project, which is the check that catches a
 * duplicate of something saved months ago.
 *
 * Earlier passes win, and the product pass runs first, so the survivor of a
 * tie is the broader statement rather than the endpoint-specific restatement.
 */
const NEAR_DUPLICATE_OVERLAP = 0.6;

export function dedupeCandidates(items) {
  const kept = [];
  const keptTokens = [];
  for (const item of items) {
    const tokens = titleTokens(item.title);
    // A use case and a context item are different shapes serving different
    // surfaces, so a similar title between them is not a duplicate.
    const dup = kept.some(
      (k, i) => k.target === item.target && overlap(tokens, keptTokens[i]) >= NEAR_DUPLICATE_OVERLAP,
    );
    if (dup) continue;
    kept.push(item);
    keptTokens.push(tokens);
  }
  return kept;
}

/** Normalize one item out of the model's JSON. Returns null to drop it. */
function normalizeCandidate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const target = raw.target === 'usecase' ? 'usecase' : 'context';
  const title = String(raw.title ?? '').trim();
  const content = String(raw.content ?? '').trim();
  if (!title || !content) return null;

  const files = Array.isArray(raw.files)
    ? raw.files.filter((f) => typeof f === 'string' && f.trim()).slice(0, 5)
    : [];

  const out = { target, title, content, files };
  if (typeof raw.endpoint === 'string' && raw.endpoint.trim()) {
    out.endpoint = raw.endpoint.trim();
  }
  if (target === 'usecase') {
    out.description = String(raw.description ?? '').trim();
    out.icon = String(raw.icon ?? 'circle').trim() || 'circle';
    out.docsBody = String(raw.docsBody ?? '').trim();
  }
  return out;
}

/**
 * The second pass: an independent model call over the extracted text alone.
 *
 * Deliberately a SEPARATE `runAI` call rather than one more instruction on the
 * end of the extraction. The extracting agent has spent minutes reading a
 * private codebase, and the one question it is least able to answer honestly
 * is whether it absorbed something it should not repeat. This one starts cold,
 * sees only the candidates, and cannot go and look.
 *
 * Fails CLOSED. If the review cannot run, or its verdict cannot be parsed, we
 * withhold everything rather than fall back to "probably fine": the entire
 * value of a leak check is that it is not optional when it is inconvenient.
 */
async function reviewForLeaks(candidates, cwd, { setSpinner, model } = {}) {
  const prompt = loadPrompt('review-context', {
    candidates: JSON.stringify(
      candidates.map((c, i) => ({ ...c, index: i })),
      null,
      2,
    ),
  });

  let verdicts;
  let reviewError = null;
  try {
    const raw = await runAI(prompt, cwd, {
      setSpinner,
      label: 'review-context',
      model, toolFree: true, sensitive: true,
      outputFormat: { type: 'json_schema', schema: {
        type: 'object', additionalProperties: false, required: ['verdicts'],
        properties: { verdicts: { type: 'array', minItems: candidates.length, maxItems: candidates.length,
          items: { type: 'object', additionalProperties: false, required: ['index', 'safe'],
            properties: { index: { type: 'integer' }, safe: { type: 'boolean' }, reason: { type: 'string' } } },
        } },
      } },
      maxTurns: MAX_TURNS_REVIEW,
      onError: (err) => { reviewError = err; },
    });
    const parsed = JSON.parse(raw);
    if (!parsed || Object.keys(parsed).join() !== 'verdicts') throw new Error('malformed-review');
    verdicts = parsed.verdicts;
  } catch {
    reviewError = reviewError || 'malformed-review';
  }

  if (reviewError) {
    return { ok: false, error: `The redaction pass couldn't run (${reviewError}).` };
  }
  if (!Array.isArray(verdicts) || verdicts.length !== candidates.length) {
    return { ok: false, error: "The redaction pass didn't return a verdict we could read." };
  }

  const byIndex = new Map();
  for (const v of verdicts) {
    if (!v || !Number.isInteger(v.index) || v.index < 0 || v.index >= candidates.length || byIndex.has(v.index)
      || typeof v.safe !== 'boolean' || (!v.safe && (typeof v.reason !== 'string' || !v.reason.trim()))
      || (v.reason !== undefined && typeof v.reason !== 'string')
      || Object.keys(v).some((k) => !['index', 'safe', 'reason'].includes(k))) {
      return { ok: false, error: 'The review returned an invalid verdict.' };
    }
    byIndex.set(v.index, v);
  }

  const safe = [];
  const withheld = [];
  candidates.forEach((candidate, i) => {
    const verdict = byIndex.get(i);
    if (verdict.safe === true) safe.push(candidate);
    else {
      withheld.push({
        title: candidate.title,
        reasons: [String(verdict.reason || 'flagged by the redaction pass')],
      });
    }
  });

  return { ok: true, safe, withheld };
}

/** Print what never left the machine, and why. */
function reportWithheld(withheld) {
  if (!withheld.length) return;
  console.log('');
  console.log(`  ${yellow('Withheld')} ${dim(`(${withheld.length}) - checked here, never uploaded:`)}`);
  for (const item of withheld) {
    console.log(`    ${dim('•')} ${white(item.title)}`);
    for (const reason of item.reasons) {
      console.log(`      ${dim(reason)}`);
    }
  }
}

/**
 * Run the whole thing for one already-chosen project.
 *
 * `project` is `{ projectId, name, slug }` from the picker; `token` is the
 * account session. Returns an exit code.
 */
export default async function contextStep({ project, token, cwd, cliVersion, yes = false, dryRun = false, full = false }) {
  let models;
  try { models = contextModels(getProvider().name); }
  catch (error) { console.log(red(error.message)); return 1; }
  const repo = describeRepo(cwd);

  console.log('');
  console.log(`  ${bold('Repository')}  ${white(repo.label)}${repo.rootPath ? dim(`/${repo.rootPath}`) : ''}`);
  console.log(`  ${bold('Project')}     ${white(project.name || project.slug)}`);
  if (!repo.isGit) {
    console.log('');
    console.log(dim("  Not a git repo, so every run reads everything. Runs here can't be incremental."));
  } else if (hasUncommittedChanges(cwd)) {
    console.log('');
    console.log(dim('  Uncommitted changes are included in what gets read, but the'));
    console.log(dim(`  watermark is recorded at HEAD (${repo.headSha.slice(0, 8)}).`));
  }

  // ── What does the project already know? ──────────────────────────────
  const scopeSpinner = startSpinner('Checking what this project already knows');
  const scope = await fetchScope({ projectId: project.projectId, token, repo });
  scopeSpinner.stop();
  if (!scope.ok) {
    console.log('');
    console.log(red(`  ✗ ${scope.error}`));
    if (scope.expired) {
      console.log(dim(`  Re-run ${cyan(`npx ${CLI_NAME} context`)} to sign in again.`));
    }
    console.log('');
    return 1;
  }

  // ── Full or incremental? ─────────────────────────────────────────────
  const lastRun = scope.source?.lastRun || null;
  let mode = 'full';
  let changedFiles = [];

  if (full && lastRun?.headSha) {
    // `--full` is the escape hatch from the watermark. Wanted whenever the
    // reason to re-read is not "the code changed": the extraction itself got
    // better, an earlier run was interrupted, or someone wants a second
    // opinion. Without it the only way to re-read an unchanged repo is to
    // commit something, which is a silly thing to make anyone do.
    console.log('');
    console.log(dim(`  --full: re-reading everything, ignoring the mark at ${lastRun.headSha.slice(0, 8)}.`));
  } else if (repo.isGit && lastRun?.headSha) {
    const diff = changedSince(cwd, lastRun.headSha);
    if (diff.ok) {
      if (diff.files.length === 0) {
        console.log('');
        console.log(green('  ✓ Nothing has changed since the last run.'));
        console.log(dim(`  ${repo.label} was last read at ${lastRun.headSha.slice(0, 8)}.`));
        console.log('');
        console.log(`  ${dim('Review anything still pending:')} ${cyan(scope.reviewUrl)}`);
        console.log('');
        return 0;
      }
      if (diff.files.length <= MAX_CHANGED_FILES) {
        mode = 'incremental';
        changedFiles = diff.files;
      } else {
        console.log('');
        console.log(dim(`  ${diff.files.length} files changed since the last run, so this is a full pass.`));
      }
    } else if (diff.reason === 'unknown-commit') {
      console.log('');
      console.log(dim(`  The last run's commit (${lastRun.headSha.slice(0, 8)}) isn't in this checkout,`));
      console.log(dim('  so this is a full pass rather than a diff against a commit we cannot see.'));
    }
  }

  // ── Plan the reading, before any model runs ──────────────────────────
  //
  // Deterministic and fast (well under a second on a 794-file repo). The
  // spec says which operations are worth documenting, the endpoint scanners
  // say which file serves each one, and what comes out is a short list of
  // files instead of an instruction to go and find the API.
  const planSpinner = startSpinner('Working out what to read');
  const plan = buildPlan({
    rootDir: cwd,
    oasFile: localOasFileFor(cwd, project.projectId),
    serverOperations: scope.endpoints || [],
    languages: detectLanguages(cwd),
    changedFiles: mode === 'incremental' ? changedFiles : null,
  });
  planSpinner.stop();

  const cov = plan.coverage;
  console.log('');
  if (plan.strategy === 'inventory') {
    console.log(`  ${dim(`No HTTP routes found here, so this reads the repo's own files (${cov.filesPlanned}).`)}`);
  } else if (plan.specSource === 'none') {
    console.log(`  ${dim(`No spec to work from, so this reads the ${cov.filesPlanned} files that define routes.`)}`);
  } else {
    console.log(
      `  ${dim(`${cov.mappedOperations} of ${cov.operations} published operations, served by ${cov.filesPlanned} file${cov.filesPlanned === 1 ? '' : 's'}.`)}`,
    );
    if (cov.endpointsFound > cov.mappedOperations) {
      // The number that explains why this is fast, and why the output is
      // about the public API rather than every route in the repo.
      console.log(
        `  ${dim(`(${cov.endpointsFound} routes exist here; the spec says which ones are public.)`)}`,
      );
    }
  }
  if (cov.filesSkipped > 0) {
    console.log(`  ${yellow(`! ${cov.filesSkipped} more files matched but exceed one run. Re-run to continue, or narrow with a subdirectory.`)}`);
  }
  if (plan.unmappedOperations.length) {
    console.log(
      `  ${dim(`${plan.unmappedOperations.length} operation${plan.unmappedOperations.length === 1 ? '' : 's'} in the spec had no file we could find; skipped.`)}`,
    );
  }

  if (!plan.batches.length && !plan.crossCutting && !plan.product) {
    console.log('');
    console.log(green('  ✓ Nothing here to read.'));
    console.log(
      dim(
        mode === 'incremental'
          ? '  None of the changed files serve the API.'
          : '  No routes, no spec, and no source files this could learn from.',
      ),
    );
    console.log('');
    return 0;
  }

  // ── Pass 1: extract, on this machine, one batch at a time ────────────
  //
  // Batched rather than one sweep, because one sweep is all-or-nothing: the
  // first real run spent its whole budget orienting itself and returned
  // nothing at all. Each batch names its own files, so a batch that fails
  // costs a batch.
  const passes = [
    // Product first: what the thing IS reads better than what its parameters
    // accept, and the "Already covered" list the later passes see grows as it
    // goes, so the broad items get proposed before the narrow ones crowd them.
    ...(plan.product ? [{ batch: plan.product, kind: 'product' }] : []),
    ...plan.batches.map((b) => ({ batch: b, kind: 'endpoints' })),
    ...(plan.crossCutting ? [{ batch: plan.crossCutting, kind: 'shared' }] : []),
  ];

  const endpointMenu = (scope.endpoints || []).length
    ? scope.endpoints.join('\n')
    : '(This project has no OpenAPI spec yet, so leave `endpoint` out of every item.)';

  const collected = [];
  const failedPasses = [];

  for (const [i, pass] of passes.entries()) {
    const name = pass.kind === 'product'
      ? 'what the product does'
      : pass.kind === 'shared'
        ? 'shared rules'
        : `batch ${pass.batch.label}`;
    const spinner = startSpinner(
      `Reading ${name} (${i + 1}/${passes.length}, ${pass.batch.files.length} files)`,
    );

    const prompt = loadPrompt('extract-context', {
      cwd,
      scope: describeBatchScope({
        batch: pass.batch,
        plan,
        mode,
        lastRun,
        label: repo.label,
        kind: pass.kind,
      }),
      existing: describeExisting(scope.existing),
      endpoints: endpointMenu,
      max: String(MAX_CANDIDATES_PER_BATCH),
    });

    // "The model found nothing" and "the model never got to answer" look
    // identical from here unless we check: the provider swallows SDK errors
    // and returns whatever partial text it had, which for a run that hit the
    // turn cap is nothing at all. A pass that failed is recorded as failed,
    // never folded into the total as an empty result.
    let raw = '';
    let runError = null;
    try {
      raw = await runAI(prompt, cwd, {
        label: `extract-context:${name}`,
        maxTurns: MAX_TURNS_PER_BATCH,
        model: models.extraction, sensitive: true,
        onError: (err) => { runError = err; },
        setSpinner: (s) => spinner.update(
          `${name} (${i + 1}/${passes.length}) ${typeof s === 'string' ? s : s?.detail || ''}`,
        ),
      });
    } catch (err) {
      runError = err.message;
    }
    spinner.stop();

    if (runError || !raw.trim()) {
      failedPasses.push({ name, reason: runError || 'returned nothing' });
      continue;
    }
    const parsed = extractJson(raw);
    if (!Array.isArray(parsed)) {
      failedPasses.push({ name, reason: "didn't return a readable list" });
      continue;
    }
    for (const item of parsed) {
      const normalized = normalizeCandidate(item);
      if (normalized) collected.push(normalized);
    }
  }

  if (failedPasses.length) {
    console.log('');
    console.log(yellow(`  ! ${failedPasses.length} of ${passes.length} passes didn't finish:`));
    for (const f of failedPasses) console.log(dim(`    ${f.name}: ${f.reason}`));
  }

  // Every pass failing is a failed run, not an empty one. Saying "nothing
  // worth saving" here would tell the user their repo had been read when none
  // of it was.
  if (failedPasses.length === passes.length) {
    console.log('');
    console.log(red('  ✗ Nothing was read, so there is nothing to report.'));
    console.log(dim('    Sensitive pass details are not recorded. The categories above identify the failures.'));
    console.log('');
    return 1;
  }

  const candidates = dedupeCandidates(collected).slice(0, MAX_CANDIDATES);

  if (!candidates.length) {
    // A genuine empty result: the model ran to completion and returned [].
    console.log('');
    console.log(green('  ✓ Nothing new worth saving.'));
    console.log(
      dim(
        mode === 'incremental'
          ? '  The changes since the last run did not alter the API contract.'
          : "  Either it is all covered already, or there is nothing here a caller could act on.",
      ),
    );
    console.log('');
    return 0;
  }

  // ── Pass 2: the leak check, before anything leaves ───────────────────
  // Deterministic rules first: they are free, they never need a model to
  // behave, and anything they catch does not need a second opinion.
  const screened = screenCandidates(candidates);
  const withheld = [...screened.withheld];

  let sendable = screened.safe;
  if (sendable.length) {
    const reviewSpinner = startSpinner('Second pass: checking nothing internal leaked');
    const review = await reviewForLeaks(sendable, cwd, {
      model: models.review,
      setSpinner: (s) => reviewSpinner.update(typeof s === 'string' ? s : s?.detail || ''),
    });
    reviewSpinner.stop();

    if (!review.ok) {
      // Fail closed. See `reviewForLeaks`.
      console.log('');
      console.log(red(`  ✗ ${review.error}`));
      console.log(dim('  Nothing was uploaded. The leak check is not optional, so a run'));
      console.log(dim('  that cannot complete it uploads nothing at all.'));
      console.log('');
      return 1;
    }
    sendable = review.safe;
    withheld.push(...review.withheld);
  }

  reportWithheld(withheld);

  if (!sendable.length) {
    console.log('');
    console.log(yellow('  Everything found was withheld. Nothing was uploaded.'));
    console.log('');
    return 0;
  }

  // ── Show what would go, and ask ──────────────────────────────────────
  console.log('');
  console.log(`  ${bold('Ready to upload')} ${dim(`(${sendable.length})`)}`);
  console.log('');
  for (const c of sendable) {
    const tag = c.target === 'usecase' ? cyan('use case') : muted('context ');
    console.log(`    ${tag}  ${white(c.title)}`);
    if (c.endpoint) console.log(`              ${dim(c.endpoint)}`);
  }
  console.log('');
  console.log(dim('  These go to your dashboard as pending suggestions. Nothing is'));
  console.log(dim('  published until you approve it there.'));
  console.log('');

  if (dryRun) {
    // Everything above this line happens on the developer's machine anyway,
    // so stopping here is a genuine preview and not a simulation of one: this
    // is exactly what would be sent. Useful for seeing what a prompt change
    // does to the output without filling a real inbox to find out.
    console.log(dim('  --dry-run: nothing was uploaded.'));
    console.log('');
    return 0;
  }

  if (!yes && isInteractive()) {
    const go = await askYesNo('  Upload these for review?', { defaultValue: true });
    if (!go) {
      console.log('');
      console.log(dim('  Nothing uploaded.'));
      console.log('');
      return 0;
    }
  }

  // ── Upload ───────────────────────────────────────────────────────────
  const uploadSpinner = startSpinner('Uploading for review');
  const pushed = await pushCandidates({
    projectId: project.projectId,
    token,
    repo: {
      host: repo.host,
      owner: repo.owner,
      repo: repo.repo,
      rootPath: repo.rootPath,
      localId: repo.localId,
      label: repo.label,
    },
    run: {
      headSha: repo.headSha,
      branch: repo.branch,
      mode,
      cliVersion,
      filesScanned: mode === 'incremental' ? changedFiles.length : 0,
      withheld: withheld.length,
    },
    candidates: sendable,
  });
  uploadSpinner.stop();

  if (!pushed.ok) {
    console.log('');
    console.log(red(`  ✗ ${pushed.error}`));
    if (pushed.expired) {
      console.log(dim(`  Re-run ${cyan(`npx ${CLI_NAME} context`)} to sign in again.`));
    }
    console.log('');
    return 1;
  }

  console.log('');
  console.log(green(`  ✓ ${pushed.created} waiting for review.`));
  if (pushed.skippedDuplicate) {
    console.log(dim(`    ${pushed.skippedDuplicate} already covered by what you have saved.`));
  }
  if (pushed.skippedUnsafe) {
    // The server's own adversarial pass, independent of the two that ran here.
    // Its reasons are printed rather than just counted: a run where the two
    // sides disagree is either a prompt that needs tuning or a leak the local
    // pass missed, and a bare number tells you neither.
    //
    // An older dashboard sends the count without the reasons. Say so, rather
    // than printing a heading with nothing under it and leaving the developer
    // to wonder whether the reasons were empty or missing.
    const reasons = pushed.dropped || [];
    if (reasons.length) {
      console.log(dim(`    ${pushed.skippedUnsafe} dropped by the safety review on upload:`));
      for (const d of reasons) {
        console.log(`      ${dim('•')} ${white(d.title)}`);
        console.log(`        ${dim(d.reason)}`);
      }
    } else {
      console.log(dim(`    ${pushed.skippedUnsafe} dropped by the safety review on upload.`));
      console.log(dim("    This dashboard doesn't report why yet, so there is nothing more to show."));
    }
  }
  console.log('');
  console.log(`  ${bold('Review them:')} ${cyan(pushed.reviewUrl)}`);
  console.log('');
  console.log(dim(`  Run ${cyan(`npx ${CLI_NAME} context`)} again after your next change and it will`));
  console.log(dim('  only read what moved.'));
  console.log('');
  return 0;
}
