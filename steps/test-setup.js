import fs from 'fs';
import path from 'path';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import { bold, dim, green, red, yellow, cyan, orange, singleSelect, ask, askYesNo, waitForServerOrKey, watchSpinner, planSpinner, terminalPreview } from '../lib/ui.js';
import { startStep } from '../lib/step-template.js';
import { SITE_URL } from '../lib/config.js';
import { loadSettings } from '../lib/settings.js';
import { pollForLandedLog, renewSetupKey, saveProjectCreds, hashWriteKey } from '../lib/project-init.js';
import { runAI, loadPrompt, languagePromptVars } from '../lib/ai.js';
import * as debug from '../lib/debug.js';
import { parseStatus, normalizeBaseUrl, basePathFromServers, describeDiagnosis, diagnoseFromHeaders, splitCurlIncludeOutput, fixActions, fixContext, portFromUrl, portFromDocker } from '../lib/test-diagnosis.js';
import { getSdkWriter, writerForExtension } from '../lib/sdk-writers/index.js';
import { loadOas } from '../lib/oas-auth.js';
import { isInteractive } from '../lib/env.js';
import { findTestCandidates, buildCurl } from '../lib/test-endpoint.js';
import { listFiles } from '../lib/grep-sdk.js';

const execAsync = promisify(exec);

// A bare host[:port] like `api.example.com` or `api.example.com:8080` -
// a token with a dot before the first slash and no scheme. Used to catch
// curls whose URL was emitted without an `http(s)://` prefix.
const SCHEMELESS_HOST = /(?<![\w./-])([a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?)(?=[/\s'"`]|$)/gi;

/**
 * Force every absolute URL in the saved curl to point at the local
 * dev server. The saved curl is built against localhost already, but
 * older/reused settings may carry a production base (from the OAS
 * `servers[0].url`), and the user can edit the box - step 3 must always
 * hit localhost so the SDK middleware runs against the dev process.
 *
 * We replace ALL `http(s)://host[:port]` occurrences (not just the
 * first) so an edge-case URL inside `--data` can't smuggle in a prod
 * call, then also rewrite any remaining schemeless `host[:port]` token
 * (curl treats `api.example.com/x` as a real http request). Trailing
 * slashes are trimmed to avoid a double-slash when the path is absolute.
 */
function rewriteCurlBase(curl, localBase) {
  const clean = localBase.replace(/\/+$/, '');
  return curl
    .replace(/https?:\/\/[^\s/'"`]+/g, clean)
    .replace(SCHEMELESS_HOST, (m) => (isLocalHost(m) ? m : clean.replace(/^https?:\/\//, '')));
}

/**
 * Strip the target API's auth off a saved curl. We now send the test
 * request unauthenticated on purpose - a rejected request (401) still
 * proves the SDK middleware saw it, and it means the user never has to
 * paste a real API key. New curls are built without auth (see
 * lib/test-endpoint.js), but settings written by older CLI versions may
 * still carry an `API_KEY_HERE` header/query, so we scrub it here.
 */
function stripAuthPlaceholder(curl) {
  return curl
    .replace(/\s+(?:-H|--header|--url-query)\s+(["'])[^"']*API_KEY_HERE[^"']*\1/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isLocalHost(host) {
  const name = host.toLowerCase().split(':')[0];
  return name === 'localhost' || name === '127.0.0.1' || name === '0.0.0.0' || name === '[::1]' || name === '::1';
}

/**
 * Belt-and-braces guard: after rewriting, sniff the actual URL the
 * curl will hit and confirm it's localhost. If somehow it isn't (the
 * user edited the box, the saved curl had a non-URL form, etc.) we
 * refuse to run and surface a clear error instead of silently firing
 * a request at production.
 */
function curlTargetIsLocal(curl) {
  const schemed = curl.match(/\bhttps?:\/\/([^\s/'"`]+)/);
  if (schemed) return isLocalHost(schemed[1]);
  // No schemed URL - look for a bare host[:port] token. curl resolves
  // `api.example.com/x` as a real http request, so a non-local bare host
  // is just as dangerous as a schemed one.
  const bare = curl.match(SCHEMELESS_HOST);
  if (bare) return bare.every(isLocalHost);
  return true; // relative URL only → curl stays local; let it fail loudly if not.
}

/**
 * The CLI needs to read response headers to know whether the SDK
 * middleware ran and whether `RESTLESS_KEY` is loaded. We do that by
 * including `-i` (or `--include`) in the curl, which prefixes the body
 * with the response headers. We refuse to run a curl without one of
 * these flags rather than silently re-add it - the visible command and
 * the executed command should match.
 */
function curlHasIncludeFlag(curl) {
  return /(?:^|\s)(?:-i|--include)(?:\s|$)/.test(curl);
}

/**
 * Parse the combined "headers + body" output produced by `curl -i`.
 * Each HTTP exchange ends in a blank line; the body follows the LAST
 * header block (anything before is from a redirect we don't care about).
 */
/**
 * Best-effort detection of the port the dev server runs on. The port is
 * almost always either declared explicitly (package.json / .env / code) or
 * left at the framework's default, so we look in that order:
 *
 *   1. package.json - a port flag / `PORT=` in the scripts, or `config.port`
 *      (via `portFromPackageJson`). Where most JS/TS apps surface their port.
 *   2. `.env*` files - `PORT=4000` and common aliases. Honored by Express /
 *      Fastify / Koa and also by `next dev` / `nuxt dev`.
 *   3. Source / config / Docker / doc files - `.listen(4000)`, the
 *      `process.env.PORT || 4000` idiom, a `port: 4000` config field, a
 *      compose `ports:` mapping / Dockerfile `EXPOSE`, or (softest fallback)
 *      a `localhost:4000` URL in a README / curl example.
 *   4. The framework's conventional default (Next 3000, Vite 5173,
 *      Angular 4200, …) via `frameworkDefaultPort`.
 *
 * Falls back to 3000 only when we can't recognize anything. Returns
 * `{ port, source }` where `source` is a short human label (a filename,
 * `package.json`, `the framework default`, or null for the blind fallback)
 * so the caller can tell the user where the guess came from. We deliberately
 * read .env* here even though AI prompts forbid it - this is a local Node
 * read, not a value sent to an LLM, and the port is the only field we extract.
 */
function isDockerFile(file) {
  return /(?:^|\/)(?:docker-compose[^/]*\.ya?ml|compose\.ya?ml|Dockerfile)$/i.test(file);
}

/** Gem names declared by whichever Ruby manifest this dir has. */

/** Dependency names declared by whichever Python manifest this dir has. */

/**
 * The local port the user's server listens on, strongest evidence first.
 *
 * One cascade for every language. It used to have six `normalizeLanguage(...)
 * === 'go' / 'ruby' / 'python'` branches - three identical loops over a file
 * list with a different parser, and three default-port blocks - which is the
 * registry's dispatch rebuilt by hand in a step file. The per-language parts
 * are now `writer.portFiles`, `writer.parsePort` and `writer.defaultLocalPort`.
 */
function detectLocalPort(searchDir, language = 'javascript', framework = '') {
  const writer = getSdkWriter(language);

  // 1. An explicit declaration in one of this language's config files.
  for (const name of writer.portFiles) {
    try {
      const full = path.join(searchDir, name);
      if (!fs.existsSync(full)) continue;
      const port = writer.parsePort(fs.readFileSync(full, 'utf8'));
      if (port) return { port, source: name };
    } catch {
      // Unreadable - try the next candidate.
    }
  }

  // 2. .env* files. We don't list every variant by hand - glob the dir. We
  //    accept an optional `export ` prefix and a trailing comment, and try
  //    the canonical `PORT` first before common alternatives.
  try {
    const envFiles = fs.readdirSync(searchDir).filter((f) => /^\.env(\..+)?$/.test(f));
    for (const name of ['PORT', 'SERVER_PORT', 'APP_PORT', 'API_PORT']) {
      const re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*["']?(\\d{2,5})["']?`, 'm');
      for (const f of envFiles) {
        try {
          const content = fs.readFileSync(path.join(searchDir, f), 'utf8');
          const m = content.match(re);
          if (m) return { port: m[1], source: f };
        } catch {}
      }
    }
  } catch {}

  // 3. Source / config / Docker / doc files. Broad extension list so we also
  //    read framework config files (next.config, vite.config, etc), Docker
  //    configs, and README / docs. We make three passes over the same files,
  //    strongest signal first: a high-confidence code/config declaration, then
  //    a Docker `ports:`/`EXPOSE`, then - only if nothing matched - a
  //    localhost URL anywhere (softest, so it never pre-empts an explicit one).
  try {
    const files = listFiles(searchDir, [
      '*.tsx', '*.ts', '*.jsx', '*.js', '*.mjs', '*.cjs', '*.py', '*.rb', '*.go',
      '*.md', '*.mdx', '*.txt',
      'docker-compose*.yml', 'docker-compose*.yaml', 'compose.yml', 'compose.yaml', 'Dockerfile',
    ], { maxDepth: 3, limit: 100 });
    const entries = [];
    for (const file of files) {
      try { entries.push({ file, content: fs.readFileSync(path.join(searchDir, file), 'utf8') }); } catch {}
    }
    for (const { file, content } of entries) {
      // Parse each file with the writer that owns its extension, so a .go file
      // in a mixed repo is read by the Go parser even though we are set up as
      // something else. Falls back to this language's parser for anything
      // unclaimed (Docker files, markdown).
      const p = (writerForExtension(path.extname(file)) || writer).parsePort(content);
      if (p) return { port: p, source: path.basename(file) };
    }
    for (const { file, content } of entries) {
      if (!isDockerFile(file)) continue;
      const p = portFromDocker(content);
      if (p) return { port: p, source: path.basename(file) };
    }
    for (const { file, content } of entries) {
      const p = portFromUrl(content);
      if (p) return { port: p, source: path.basename(file) };
    }
  } catch {}

  // 4. Nothing explicit - fall back to the framework's conventional default.
  return writer.defaultLocalPort(searchDir, framework) || { port: '3000', source: null };
}

export default async function testSetup({
  packageDir,
  rootDir,
  apiRootDir,
  update,
  setSpinner,
  domain,
  projectId,
  setupKey,
  ctx = {},
}) {
  const aiTool = ctx.aiTool || 'the AI';

  const searchDir = apiRootDir && apiRootDir !== '.' ? path.resolve(packageDir, apiRootDir) : packageDir;
  // The SDK was wired into this same directory by the install step, so
  // that's where the fix AI should run.
  const installDir = searchDir;

  // The test curl was picked at the end of step 1 (auth stripped - we send
  // it unauthenticated on purpose). We re-point its base at the current URL
  // on every probe. Falls back to a bare GET / if none was saved.
  const settings = loadSettings(rootDir);
  const apiEntry = settings.apis?.find((a) => a.rootDir === (apiRootDir || '.')) || settings.apis?.[0];
  const savedCurl = apiEntry?.testCurl ? stripAuthPlaceholder(apiEntry.testCurl) : null;

  // The base URL is mutable - the user can correct a wrong guess mid-flight,
  // so `localBase()` always reflects the current choice. We compose it from
  // the detected port plus any base path the OAS mounts the API under (e.g.
  // servers `.../api` → we probe `http://localhost:PORT/api`), so an API
  // that isn't at the root still gets hit correctly.
  const detected = detectLocalPort(searchDir, ctx?.language, ctx?.framework);
  let oas = null;
  try { if (apiEntry?.oasFile) oas = loadOas(path.resolve(rootDir, apiEntry.oasFile)); } catch {}
  const basePath = basePathFromServers(oas);
  let baseUrl = `http://localhost:${detected.port}${basePath}`;
  const localBase = () => baseUrl;
  debug.log('test-setup.url-detected', { url: baseUrl, portSource: detected.source, basePath });

  function buildProbeCurl() {
    const base = savedCurl ? rewriteCurlBase(savedCurl, localBase()) : `curl -sS ${localBase()}/`;
    let cmd = curlHasIncludeFlag(base) ? base : base.replace(/^curl\b/, 'curl -i');
    if (!curlTargetIsLocal(cmd)) cmd = rewriteCurlBase(cmd, localBase());
    return cmd;
  }

  const pollConfig = projectId ? { url: `${SITE_URL}/api/logs/poll`, projectId, setupKey } : null;

  // The intro waits until here on purpose: the command box below shows the
  // real curl we're about to send, which needs the detected port and the
  // test endpoint picked back in step 1.
  await startStep({
    update,
    stepNum: 3,
    title: 'Test your setup',
    // The old "How:" paragraph, as bullets - same facts, but you can find
    // the one you care about without reading the whole thing.
    intro:
      "Now let's confirm the SDK is picking up your requests.\n" +
      '\n' +
      `  ${dim('·')} We'll watch for your server to start\n` +
      `  ${dim('·')} We'll send a few real requests through the SDK\n` +
      `  ${dim('·')} If something's wrong, ${orange(aiTool)} will fix it and recheck`,
    // The dim follow-on says WHY they're being asked to go start a server -
    // the ask lands better with the reason attached, and it's wrapped by
    // hand so it can't reflow into the amber line above it on a narrow term.
    actionRequired:
      'Start your server in another terminal.\n' +
      dim("We're going to make a request to your dev server to confirm") + '\n' +
      dim("it's wired up properly!"),
    // The command box below is the gate - no separate keypress question.
    skipWait: true,
  });

  // Read-only: this is what we're about to run, not something to edit.
  await terminalPreview(buildProbeCurl(), {
    cta: 'Press ENTER to run it',
    note: "we'll keep trying until your server answers",
  });

  // Fire one request at the local server and classify from the response
  // headers. A connection error → 'unreachable' (server down / wrong port);
  // otherwise the SDK's request-id header tells us the rest. We pipe
  // curl's stderr (stdio slot 2) instead of letting it inherit the terminal -
  // otherwise a failed connection prints a raw `curl: (7) Failed to connect…`
  // line that corrupts the rendered plan UI.
  function probe() {
    const cmd = buildProbeCurl();
    if (!curlTargetIsLocal(cmd)) return { state: 'unreachable' };
    try {
      const raw = execSync(cmd, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
      const { headers } = splitCurlIncludeOutput(raw);
      const diag = diagnoseFromHeaders(headers);
      return { state: diag.state, status: parseStatus(raw), requestId: diag.requestId };
    } catch (err) {
      debug.log('test-setup.probe-unreachable', { message: String(err?.message || '').slice(0, 160) });
      return { state: 'unreachable' };
    }
  }

  // Render a diagnosis into the plan step message. The waiting state also
  // gets a footer advertising the escape-hatch keys.
  function render(state, { status, attempt, frame } = {}) {
    const { icon, lines, waiting } = describeDiagnosis(state, { status, localBase: localBase(), aiTool, attempt, frame });
    const msg = [`  ${icon}  ${lines[0]}`, ...lines.slice(1).map((l) => `     ${l}`)];
    // `waiting` = we haven't reported a problem yet (still just connecting),
    // so the change-the-URL / skip escape hatches would read as one.
    if (state === 'unreachable' && !waiting) {
      msg.push('');
      msg.push(dim(`     Not the right address? Press ${bold('p')} to change the URL · ${bold('Tab')} to skip`));
    }
    update({ message: msg });
  }

  // ── Visible "test" batch ────────────────────────────────────────────────
  // A single silent probe reads as "did it even do anything?". Once we know
  // the server is up and the SDK is wired, we fire a few real requests and
  // show each one's status code + whether the SDK captured it - so it's
  // obvious we tested it and it worked, even when the statuses are 401s.

  // Up to 3 safe GET requests from the OAS's ranked test candidates (so we
  // exercise a few real endpoints). Falls back to the single saved probe curl.
  function buildTestRequests() {
    const reqs = [];
    try {
      if (oas) {
        for (const cand of findTestCandidates(oas, { max: 3 })) {
          let curl = buildCurl(oas, cand, localBase());
          if (!curlHasIncludeFlag(curl)) curl = curl.replace(/^curl\b/, 'curl -i');
          if (curlTargetIsLocal(curl)) reqs.push({ method: cand.method, path: cand.path, curl });
        }
      }
    } catch {}
    if (!reqs.length) {
      const curl = buildProbeCurl();
      const method = (curl.match(/(?:-X|--request)\s+(\w+)/)?.[1] || 'GET').toUpperCase();
      let p = '/';
      try { const u = new URL(curl.match(/\bhttps?:\/\/[^\s"']+/)?.[0] || ''); p = u.pathname + (u.search || ''); } catch {}
      reqs.push({ method, path: p, curl });
    }
    return reqs.slice(0, 3);
  }

  function colorStatus(status) {
    if (status == null) return dim('---');
    const s = String(status);
    if (status >= 200 && status < 300) return green(s);
    if (status >= 500) return red(s);
    return yellow(s); // 3xx / 4xx (incl. an expected 401) - not an error for us
  }

  // Render the batch rows as plan-message lines. `done` swaps the spinner
  // header for a summary of how many the SDK captured. While it's running the
  // header carries the same breathing spinner the plan draws (`planSpinner`),
  // so this screen reads as "working" like every other waiting screen.
  function batchLines(rows, { done = false, frame = 0 } = {}) {
    const captured = rows.filter((r) => r.captured).length;
    const header = done
      ? `  ${green('✓')} Sent ${rows.length} test request${rows.length === 1 ? '' : 's'} - the SDK saw ${captured}/${rows.length}.`
      : `  ${planSpinner(frame)} Sending a few test requests through the SDK…`;
    const lines = [header, ''];
    for (const r of rows) {
      const label = `${r.method} ${r.path}`;
      const padded = label.length >= 30 ? label : label.padEnd(30);
      let tail;
      if (r.state === 'done') {
        tail = `${colorStatus(r.status)}   ${r.captured ? green('✓ SDK') : yellow('⚠ missed')}`;
      } else if (r.state === 'running') {
        tail = dim('sending…');
      } else {
        tail = dim('queued');
      }
      lines.push(`     ${padded}  ${tail}`);
    }
    return lines;
  }

  // Fire the batch. Interactively we animate it row-by-row (each request flips
  // from "sending…" to its status code); non-interactively we run them all and
  // let the caller print the final list once (no per-row redraw spam).
  async function runTestBatch() {
    const rows = buildTestRequests().map((r) => ({ ...r, state: 'pending', status: null, captured: false }));
    const interactive = isInteractive();
    let frame = 0;
    const draw = () => update({ message: batchLines(rows, { frame }) });
    // The curls run async (not execSync) so the event loop stays free and the
    // header spinner keeps breathing while a request is in flight.
    const ticker = interactive ? setInterval(() => { frame++; draw(); }, 180) : null;
    try {
      if (interactive) draw();
      for (const row of rows) {
        if (interactive) { row.state = 'running'; draw(); await new Promise((r) => setTimeout(r, 250)); }
        let raw = null;
        try {
          raw = (await execAsync(row.curl, { encoding: 'utf8', timeout: 10000 })).stdout;
        } catch (err) {
          // curl exits non-zero on a transport failure (connection refused,
          // timeout). An HTTP error status is still exit 0, so anything we get
          // on stdout is worth parsing.
          raw = err?.stdout || null;
        }
        if (raw) {
          row.status = parseStatus(raw);
          row.captured = diagnoseFromHeaders(splitCurlIncludeOutput(raw).headers).state !== 'no-sdk';
        } else {
          row.status = null;
          row.captured = false;
        }
        row.state = 'done';
        if (interactive) draw();
      }
    } finally {
      if (ticker) clearInterval(ticker);
    }
    return rows;
  }

  // Poll the dashboard for a log from this run. A landed log (any status,
  // incl. 401) proves RESTLESS_KEY is valid end-to-end; nothing landing
  // after a clean header points at a stale key.
  // Renews this setup's key once if the poll 401s (a run that outlived the six-hour key).
  const renew = ctx.apiKey
    ? async () => {
        const renewed = await renewSetupKey({ projectId, writeKeyHash: hashWriteKey(ctx.apiKey) });
        if (renewed.claimed) return null;
        saveProjectCreds({ projectId, setupKey: renewed.setupKey, apiKey: ctx.apiKey });
        setupKey = renewed.setupKey;
        return renewed.setupKey;
      }
    : null;

  // `{ landed, count, unauthorized }`; with no project to poll, the clean header is all we have.
  async function dashboardLogged(since) {
    if (!pollConfig) return { landed: true };
    const poll = await pollForLandedLog({ projectId, setupKey, since, renew });
    debug.log('test-setup.poll', { landed: poll.landed, count: poll.count ?? 0, unauthorized: !!poll.unauthorized });
    return poll;
  }

  async function changeUrl() {
    const answer = await ask(`\n  ${cyan('?')} What URL is your server on? `, { defaultValue: baseUrl });
    const u = normalizeBaseUrl(answer);
    if (u) baseUrl = u;
    return baseUrl;
  }

  // Hand the runtime evidence to the agent and let it edit the code.
  async function runFix(state) {
    const { evidence, guidance } = fixContext(state, { localBase: localBase() });
    update({ message: [
      `  ${orange(aiTool)} is reading your code and fixing the wiring…`,
      dim(`     When it's done, restart your server - we'll re-check on our own.`),
    ]});
    debug.log('test-setup.fix-start', { state });
    try {
      await runAI(loadPrompt('fix-sdk', { ...languagePromptVars(ctx?.language), evidence, guidance, base: localBase() }), installDir, { setSpinner, label: 'fix-sdk' });
      update({ message: [
        `  ${green('✓')} ${orange(aiTool)} applied a fix. ${bold('Restart your server')} and we'll re-check automatically.`,
      ]});
    } catch (err) {
      debug.log('test-setup.fix-error', { message: String(err?.message || '').slice(0, 160) });
      update({ message: [
        `  ${yellow('⚠')} Couldn't complete the automatic fix. Check the notes above, then restart your server.`,
      ]});
    }
  }

  function confirmSkip() {
    return askYesNo(`\n  ${yellow("Skip without confirming the SDK is set up?")} `, { defaultValue: false });
  }

  function finishSkipped(lastState) {
    update({ status: 'done', message: [
      `  ${yellow('⚠')} Skipped the setup check - you can run setup again anytime to finish it.`,
    ]});
    debug.log('test-setup.skipped', { lastState });
  }

  // ── Non-interactive (agent / CI) ───────────────────────────────────────
  // The interactive loop below relies on a human to press keys, restart the
  // server on cue, and drive the fix menu - none of which happens under an
  // agent, so it would hang (the post-fix watch waits forever for a manual
  // restart). Instead: poll for the server for a bounded window, diagnose,
  // and on success fire the visible batch and report. Success = the SDK saw
  // the request (any status, incl. a 401 / `missing-key` - an agent has no
  // key and doesn't need one). On a real failure we surface the diagnosis +
  // fix guidance and return, rather than blocking on a restart we can't get.
  if (!isInteractive()) {
    const MAX_ATTEMPTS = 15; // ~30s at 2s spacing - room for a dev server to boot
    let diag = { state: 'unreachable' };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      diag = probe();
      if (diag.state !== 'unreachable') break;
      if (attempt === 1) render('unreachable', { attempt });
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (diag.state === 'unreachable') {
      update({ status: 'done', message: [
        `  ${yellow('⚠')} Couldn't reach your server at ${bold(localBase())} within the wait window.`,
        dim(`     Start it (or fix the URL) and run setup again to finish the check.`),
      ]});
      debug.log('test-setup.noninteractive', { state: 'unreachable' });
      return { success: false, diagnostic: 'unreachable' };
    }

    if (diag.state === 'ok' || diag.state === 'no-key') {
      const since = new Date(Date.now() - 15000).toISOString();
      const rows = await runTestBatch();
      let poll = { landed: false };
      if (diag.state === 'ok' && pollConfig) poll = await dashboardLogged(since);
      const landed = poll.landed;
      const msg = batchLines(rows, { done: true });
      msg.push('');
      if (diag.state === 'no-key') {
        msg.push(`  ${green('✓')} The SDK is wired up and capturing requests.`);
        msg.push(dim(`     No ${bold('RESTLESS_KEY')} is set, so nothing was uploaded - set it and restart to stream logs.`));
      } else {
        const extra = landed ? ` and logging them to your dashboard${poll.count > 1 ? ` (${poll.count} received)` : ''}` : '';
        msg.push(`  ${green('✓')} The SDK is picking up your requests${extra}.`);
        if (poll.unauthorized) msg.push(dim(`     This setup's key has expired, so the dashboard check was skipped - run ${bold('npx restless login')} to refresh it.`));
        else if (!landed && pollConfig) msg.push(dim(`     Header looked good but no log reached the dashboard - double-check ${bold('RESTLESS_KEY')}.`));
      }
      update({ status: 'done', message: msg });
      debug.log('test-setup.noninteractive', { state: diag.state, landed, unauthorized: !!poll.unauthorized, tested: rows.length });
      return { success: true, diagnostic: poll.unauthorized ? 'setup-expired' : diag.state, setupKey };
    }

    // no-sdk / stale-key → a real problem. Report the diagnosis and, when the
    // state is AI-fixable, the exact guidance so the outer agent can fix it.
    const desc = describeDiagnosis(diag.state, { status: diag.status, localBase: localBase(), aiTool });
    const msg = [`  ${desc.icon}  ${desc.lines[0]}`, ...desc.lines.slice(1).map((l) => `     ${l}`)];
    if (desc.canFix) {
      const { guidance } = fixContext(diag.state, { localBase: localBase() });
      if (guidance) msg.push(dim(`     Fix hint: ${guidance}`));
    }
    update({ status: 'done', message: msg });
    debug.log('test-setup.noninteractive', { state: diag.state });
    return { success: false, diagnostic: diag.state };
  }

  // ── Main loop: watch → diagnose → (fix / retry / port / skip) → repeat ──
  let lastState = null;
  while (true) {
    // Passive watch: poll until the server answers, or the user hits a key.
    const ev = await waitForServerOrKey(probe, {
      intervalMs: 2000,
      render: (attempt, frame) => render('unreachable', { attempt, frame }),
    });

    if (ev.type === 'key') {
      if (ev.key === '\t') {
        if (await confirmSkip()) { finishSkipped(lastState); return { success: false, diagnostic: lastState }; }
        continue;
      }
      if ((ev.key || '').toLowerCase() === 'p') { await changeUrl(); continue; }
      continue; // any other key → re-check immediately
    }

    const diag = ev.result;
    lastState = diag.state;

    // Success path: the header is clean. Confirm the log reached the
    // dashboard (when we can) to catch a stale key; otherwise the clean
    // header is enough.
    if (diag.state === 'ok') {
      const since = new Date(Date.now() - 15000).toISOString();
      // Fire a few real requests, animating each status code as it lands, so
      // it's visibly clear we tested it and it works.
      const rows = await runTestBatch();
      const poll = await dashboardLogged(since);
      if (poll.landed) {
        const extra = pollConfig ? ` and logging them to your dashboard${poll.count > 1 ? ` (${poll.count} received)` : ''}` : '';
        const msg = batchLines(rows, { done: true });
        msg.push('');
        msg.push(`  ${green('✓')} The SDK is picking up your requests${extra}.`);
        update({ status: 'done', message: msg });
        debug.log('test-setup.done', { state: 'ok', logged: !!pollConfig, tested: rows.length });
        return { success: true, diagnostic: 'ok', setupKey };
      }
      // Captured but nothing landed upstream is the stale-key signature; a poll our own expired
      // key could not make is not, and must never be blamed on the user's RESTLESS_KEY.
      if (poll.unauthorized) {
        // The SDK passed; only our credential lapsed. The account step renews it while staging
        // the claim, so a fix menu here would stop the run one step short of the link.
        const msg = batchLines(rows, { done: true });
        msg.push('');
        msg.push(`  ${green('✓')} The SDK is picking up your requests.`);
        msg.push(dim(`     This setup's key had expired, so the dashboard check was skipped - the claim step refreshes it.`));
        update({ status: 'done', message: msg });
        debug.log('test-setup.done', { state: 'setup-expired', tested: rows.length });
        return { success: true, diagnostic: 'setup-expired', setupKey };
      }
      diag.state = 'stale-key';
      lastState = 'stale-key';
    }

    // Failing path: show the diagnosis, then offer the fix loop.
    render(diag.state, { status: diag.status });
    // Same picker as every other question in the flow - the fix menu used to
    // draw its own variant, which read as a different kind of prompt.
    const actions = fixActions(diag.state, { aiTool });
    const picked = await singleSelect(
      actions.map((a) => ({ label: a.label, hint: a.hint })),
      { message: 'What would you like to do?', defaultIndex: 0 },
    );
    const action = actions[picked].key;
    if (action === 'skip') {
      if (await confirmSkip()) { finishSkipped(lastState); return { success: false, diagnostic: lastState }; }
      continue;
    }
    if (action === 'port') { await changeUrl(); continue; }
    if (action === 'fix') {
      await runFix(diag.state);
      // The server is still running the OLD code until the user restarts,
      // so an immediate re-probe would show the same failure and read as
      // "the fix didn't work". Wait until the diagnosis actually CHANGES
      // (the restart landed) - or the user presses a key to re-check now.
      const prev = diag.state;
      await waitForServerOrKey(
        () => {
          const r = probe();
          return r.state === prev ? { state: 'unreachable' } : r;
        },
        {
          intervalMs: 2000,
          render: (attempt, frame) => update({ message: [
            `  ${watchSpinner(frame)}  Fix applied - ${bold('restart your server')} and we'll pick it up…`,
            dim(`     Press any key to re-check now.`),
          ]}),
        },
      );
      continue; // re-enter the main watch, which re-probes fresh.
    }
    // 'recheck' → loop again; waitForServerOrKey probes immediately.
  }
}
