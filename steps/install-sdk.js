import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { runAI, loadPrompt, loadPromptForLanguage, pkgRoot } from '../lib/ai.js';
import { bold, dim, green, red, cyan, yellow, orange, ask, terminalPrompt, waitForKey } from '../lib/ui.js';
import { startStep } from '../lib/step-template.js';
import { CLI_NAME } from '../lib/config.js';
import { safeWriteFileSync, isInsideRoot } from '../lib/pathGuard.js';
import { fatalError } from '../lib/errors.js';
import * as debug from '../lib/debug.js';
import * as timings from '../lib/timings.js';
import { buildWiringSourceBlock } from '../lib/inline-source.js';
import { getSdkWriter, normalizeLanguage } from '../lib/sdk-writers/index.js';
import { findWiredSourceFile as findWired } from '../lib/wired-file.js';
import {
  describeMissingSdk,
  installCommandFor,
  isSdkInstalled,
} from '../lib/install-target.js';
import {
  detectNext,
  isNextFramework,
  nextAutoWrapSupport,
  nextPluginWiringStatus,
  findNextConfigFile,
} from '../lib/next-detect.js';


/**
 * The wired file, with the STRICT predicate.
 *
 * `hasInit`, not `hasSdkReference`: the latter matches any mention of the
 * package - a comment, a test fixture, a config string all qualify - while
 * `hasInit` requires an actual constructor call, which is the only thing that
 * plumbs the SDK into the user's code. This decides whether to skip the AI
 * wiring pass on a re-run, so a false positive means shipping unwired.
 *
 * No plugin short-circuit here: this step handles the Next.js plugin case
 * separately through `nextWiringStatus`.
 */
function findWiredSourceFile(installDir, language = 'javascript') {
  return findWired(installDir, language, { plugin: false, debugTag: 'install-sdk' });
}

/**
 * After the AI wires in the SDK, the CLI takes ownership of the init
 * line: rewrites the init arg to match `getSdkLineSpec(ctx)` (literal /
 * env-ref / no-arg). Auth extraction and owner.id (the AI's
 * domain-specific work) are preserved.
 */
function canonicalizeSdkBlock(ctx) {
  const writer = getSdkWriter(ctx.language);
  const file = findWiredSourceFile(ctx.installDir, ctx.language);
  if (!file) return { mode: 'no-source', file: null };
  const content = fs.readFileSync(file, 'utf8');
  const next = writer.canonicalizeInitArg(content, ctx);
  if (next !== content) safeWriteFileSync(file, next);
  return { mode: 'canonicalized', file: path.relative(ctx.installDir, file) };
}


/**
 * Check whether `@restlessai/sdk` is actually wired into the user's
 * source. Used to skip the setup AI pass when someone's re-running the
 * CLI - but only when there's a REAL wired block, not just a comment
 * or stale partial reference left over from an earlier run. Goes
 * through `findWiredSourceFile` so the grep + writer.parse() check
 * matches the one canonicalize and final-checks use.
 *
 * Past bug: a raw grep here returned true on stray references and
 * skipped the AI wiring pass entirely, leaving the user with an
 * unwired SDK and the CLI marking the step as done.
 */
function isSdkWired(packageDir, language = 'javascript') {
  return findWiredSourceFile(packageDir, language) !== null;
}

/**
 * Next.js wiring gate for the MANUAL (per-route factory) style, plus the
 * middleware guard that applies to every style.
 *
 * On Next.js the SDK must NEVER be wired into the middleware file
 * (`middleware.ts` / `proxy.ts`). Next passes middleware a `NextRequestHint`
 * whose `.request` getter throws `PageSignatureError` (E394) the moment the
 * SDK's adapter sniffs its argument, and middleware runs on the Edge runtime
 * where an `owner.enrich` DB lookup can't run either. So `isSdkWired` alone
 * (any file with a factory call) is not enough: a middleware wiring passes
 * that check yet ships a crashing install.
 *
 * Returns which factory-call files sit on the middleware side vs the handler
 * side, and `ok` = at least one handler-side wiring AND zero middleware
 * wirings. The plugin-style wiring (withRestless + restless.config) has no
 * factory call and is invisible here - `nextPluginWiringStatus` in
 * lib/next-detect.js covers it; the composed gate lives in `wiredNow` below.
 */
export function nextWiringStatus(installDir, nextInfo, language = 'javascript') {
  const writer = getSdkWriter(language);
  const mwSet = new Set(nextInfo.middlewareFiles);
  const wired = [];
  for (const rel of writer.candidateWiringFiles(installDir)) {
    try {
      if (writer.hasInit(fs.readFileSync(path.join(installDir, rel), 'utf8'))) wired.push(rel);
    } catch {
      // Unreadable mid-rewrite file - skip, same as findWiredSourceFile.
    }
  }
  const wiredMiddleware = wired.filter((rel) => mwSet.has(rel));
  const wiredHandlerSide = wired.filter((rel) => !mwSet.has(rel));
  return {
    wired,
    wiredMiddleware,
    wiredHandlerSide,
    ok: wiredMiddleware.length === 0 && wiredHandlerSide.length > 0,
  };
}

function listPaths(paths, installDir) {
  const shown = paths.map((p) => (isInsideRoot(p, installDir) ? path.relative(installDir, p) || '.' : p));
  return shown.length > 3 ? `${shown.slice(0, 3).join(', ')} and ${shown.length - 3} more` : shown.join(', ');
}

/**
 * What the wiring AI actually did across its attempts, one sentence per fact.
 * Every failed-wiring message is built from this rather than assumed.
 */
export function describeAiActivity({ edited = [], denied = [] }, installDir, aiTool) {
  const lines = [];
  if (denied.length) {
    lines.push(`${aiTool} tried to change files outside this project (${listPaths(denied, installDir)}), and the CLI refused.`);
  }
  if (edited.length) {
    lines.push(`${aiTool} edited ${listPaths(edited, installDir)}, but the SDK still isn't wired in.`);
  }
  if (!lines.length) lines.push(`${aiTool} read your project but never modified a source file.`);
  return lines;
}

export default async function installSdk({
  ctx,
  update,
  setSpinner,
  // Runs between Install package (sub 0) and Configure SDK (sub 2).
  // Owns sub 1 (Generate API key). Should resolve to whatever
  // prepareAccount returns - we forward it back in our own return value.
  prepareAccountStep,
}) {
  const { packageDir, installDir, framework: detectedFramework, aiTool = 'Claude Code' } = ctx;
  let detectedLanguage = ctx.language;
  const frameworkLabel = detectedFramework || detectedLanguage || 'your framework';
  const installDirRel = path.relative(packageDir, installDir) || '.';
  // Friendly version for prose: "the root" when there's no relative path,
  // otherwise the relative path (e.g. "packages/api"). The bold-highlighted
  // version of "the root" stays as just bold "the root" - it reads as a
  // location, not a literal path.
  const installLocation = installDirRel === '.' ? bold('the root') : bold(installDirRel);

  await startStep({
    update,
    stepNum: 2,
    title: 'Install the SDK',
    // Three bullets, no Why / Privacy essay: what the step is about to do to
    // their project, in the order it does it. The welcome screen already
    // covered where the AI runs and what leaves the machine.
    intro:
      `Now let's drop the Restless SDK into your ${bold(frameworkLabel)} project.\n` +
      '\n' +
      `  ${dim('·')} We'll wire up the SDK in your codebase\n` +
      `  ${dim('·')} We'll generate a Restless API key\n` +
      `  ${dim('·')} We'll upload a test log to our servers`,
    sections: [],
    // The terminal prompt below is the action - no separate keypress gate.
    skipWait: true,
  });

  if (!detectedLanguage) detectedLanguage = 'javascript';
  // Also the name of the guide in `docs/sdks/`, so it has to go through the
  // same normalization the writer registry uses - otherwise `node` picks the
  // JS writer but looks for a `docs/sdks/node.md` that doesn't exist.
  const guideLanguage = normalizeLanguage(detectedLanguage);
  // What this language's package is CALLED, for anything we show the user.
  // Hardcoding `@restlessai/sdk` here told a Rails user we were installing an
  // npm package, and in the install-failure path it contradicted the
  // per-language reason printed directly beneath it.
  const sdkName = getSdkWriter(guideLanguage).descriptor.packageSpecifier;

  // Next.js needs a fundamentally different wiring than the middleware /
  // plugin model the guide's Express/Fastify/Koa sections describe, and it
  // comes in two styles:
  //
  //   - 'plugin' (App Router on Next >= 13.4 / Turbopack >= 15.3): the
  //     single-config integration. `withRestless` wraps the exported config
  //     in next.config.*, `restless.config.*` holds the capture config, and
  //     a build-time loader auto-wraps every route handler. Route files are
  //     not touched.
  //   - 'manual' (Pages Router, or App Router on an older Next): wrap route
  //     handlers by hand with `@restlessai/sdk/next`.
  //
  // Either way the SDK must NEVER be wired into the middleware file
  // (`middleware.ts` / `proxy.ts`). Detect the layout up front - before the
  // install and API key steps - so we can (a) fail fast when there's nothing
  // to wrap, (b) hand the AI the exact files, and (c) reject a middleware
  // wiring in the gate below. The plugin-vs-manual STYLE decision happens
  // after the install sub-step: it depends on the installed SDK version.
  const nextInfo = detectNext(installDir);
  // Trigger the Next.js path only on corroborated evidence: actual App/Pages
  // routing files, a Next middleware file, or a Next framework label from
  // detection. A bare `next` dependency alone (common in monorepo packages
  // that don't actually serve the API through Next) must NOT hijack the flow.
  const isNext =
    nextInfo.router !== null ||
    nextInfo.middlewareFiles.length > 0 ||
    isNextFramework(detectedFramework);
  debug.log('install-sdk.next-detect', {
    isNext,
    router: nextInfo.router,
    routeHandlers: nextInfo.routeHandlerFiles.length,
    middlewareFiles: nextInfo.middlewareFiles,
  });

  if (isNext && nextInfo.routeHandlerFiles.length === 0) {
    // Nothing to capture. The only place left to put capture would be the
    // middleware file - which is exactly the crash we're guarding against -
    // so fail loudly with a clear message instead of emitting broken code.
    // (The auto-wrap plugin needs route handlers just the same: it wraps
    // `app/**/route.*` files, so an empty app captures nothing.)
    const mwList = nextInfo.middlewareFiles.map((f) => bold(f)).join(', ')
      || `${bold('middleware.ts')} / ${bold('proxy.ts')}`;
    debug.log('install-sdk.next-no-handlers', { installDir, middlewareFiles: nextInfo.middlewareFiles });
    fatalError(
      "We couldn't wire the SDK into this Next.js project.",
      [
        `The Restless SDK captures traffic from App Router route handlers`,
        `(${bold('app/**/route.ts')}) or Pages Router API routes (${bold('pages/api/**')}),`,
        `but we found none under ${installLocation}.`,
        '',
        `It must NOT go in your Next middleware (${mwList}) - that runs on the Edge`,
        `runtime and crashes with a PageSignatureError.`,
        '',
        `Add at least one route handler, then re-run \`npx ${CLI_NAME} init\`.`,
      ],
    );
    // Unreachable: fatalError throws FatalExit.
    return { detectedLanguage, detectedFramework, guideLanguage, installed: false, wired: false };
  }

  // ── Sub 0: Install package ───────────────────────────────────────────────
  const alreadyInstalled = isSdkInstalled(installDir, guideLanguage);
  if (alreadyInstalled) {
    update({ sub: { 0: 'done' }, activeSub: 1, message: [
      `  ${green('✓')} ${bold(sdkName)} is already installed in ${installLocation} - skipping install.`,
    ]});
  } else {
    const defaultCmd = installCommandFor(guideLanguage);
    const cdPrefix = installDirRel !== '.' ? `cd ${installDirRel} && ` : '';
    // Keep the step intro visible above the prompt - just advance the cursor.
    update({ activeSub: 0 });
    const cmd = await terminalPrompt(cdPrefix + defaultCmd);

    update({ activeSub: 0, message: [
      `  Installing ${bold(sdkName)} in ${installLocation}…`,
    ]});
    // Labelled with the DEFAULT command, not the one the user may have
    // edited at the prompt: the label is a key the report groups on across
    // runs, so it has to be stable.
    const endInstallSpan = timings.start(`install: ${defaultCmd}`, {
      kind: timings.KINDS.EXEC,
      language: guideLanguage,
    });
    try {
      // Use packageDir as cwd so the `cd ...` prefix resolves correctly.
      execSync(cmd, { cwd: packageDir, stdio: 'pipe', shell: true });
    } catch {
      // Install warnings can trip non-zero exits; the verify step below catches
      // a genuine failure.
    } finally {
      endInstallSpan();
    }
    if (!isSdkInstalled(installDir, guideLanguage)) {
      // Halt loudly. Earlier versions returned a `{ installed: false }`
      // sentinel and trusted the caller to check it - but bin/restless.js
      // didn't, so finalChecks ran with `prevSubs: { 0:'done', 1:'done',
      // 2:'done' }` and painted phantom green checkmarks over a step
      // that genuinely failed. Never silently push past a failed install.
      debug.log('install-sdk.install-failed', { installDir, cmd });
      fatalError(
        `Install didn't complete - ${bold(sdkName)} isn't reachable from ${bold(installDirRel)}.`,
        [
          ...describeMissingSdk(installDir, guideLanguage),
          `Try running the command yourself, then re-run \`npx ${CLI_NAME} init\`:`,
          `  ${cmd}`,
        ],
      );
      // Unreachable: fatalError throws FatalExit.
      return { detectedLanguage, detectedFramework, guideLanguage, installed: false, wired: false };
    }
    update({ sub: { 0: 'done' }, activeSub: 1, message: [
      `  ${green('✓')} Package installed in ${installLocation}.`,
    ]});
  }

  // Pick the Next.js wiring style now that the SDK on disk is final:
  //
  //   - 'plugin' (App Router; Next >= 13.4 / Turbopack >= 15.3; installed
  //     @restlessai/sdk >= 0.4.0): the single-config integration.
  //     `withRestless` wraps the exported config in next.config.*,
  //     `restless.config.*` holds the capture config, and a build-time
  //     loader auto-wraps every route handler. Route files are not touched.
  //   - 'manual' (Pages Router, older Next, or an older pre-installed SDK
  //     that predates the plugin): wrap route handlers by hand with
  //     `@restlessai/sdk/next`.
  //
  // This must run AFTER the install sub-step (a fresh `npm install` pulls
  // the latest SDK; a skipped install can leave an old one that lacks the
  // plugin exports) and BEFORE prepare-account, which reads ctx.nextStyle
  // to drop the inline-key option on plugin installs (they have no init
  // line to inline a key into).
  const autoWrap = isNext && nextInfo.router === 'app'
    ? nextAutoWrapSupport(installDir)
    : { supported: false, version: null, sdkVersion: null, reason: null };
  const nextStyle = !isNext ? null : (autoWrap.supported ? 'plugin' : 'manual');
  ctx.nextStyle = nextStyle;
  if (isNext) {
    debug.log('install-sdk.next-style', {
      style: nextStyle,
      nextVersion: autoWrap.version,
      sdkVersion: autoWrap.sdkVersion,
      autoWrapReason: autoWrap.reason,
    });
  }

  // ── Sub 1: Generate API key (delegated to the caller) ────────────────────
  let prepareResult = null;
  if (prepareAccountStep) {
    prepareResult = await prepareAccountStep();
  }

  // ── Sub 2: Configure SDK ─────────────────────────────────────────────────
  //
  // Repaint the message slot immediately so the user sees the new sub-step
  // becoming active. The synchronous prep below (grep for existing wiring,
  // read guide files, build the prompt) runs on the event loop - if any of
  // it ever blocks for more than a moment, the previous sub's message would
  // otherwise stay frozen on screen and look like a hang. Past incident:
  // recursive grep over a populated node_modules took 30s+ on first install,
  // and the UI sat showing the "Added RESTLESS_KEY to .env" message the
  // whole time with no spinner.
  update({ activeSub: 2, message: [
    `  Configuring ${bold(sdkName)} in your ${bold(detectedFramework || detectedLanguage)} code…`,
  ]});
  // We deliberately do NOT short-circuit the AI even when the SDK looks
  // wired in already. Three real failure modes from the "already wired"
  // shortcut bit us in a row:
  //   1. Raw grep matched on stray comments / test fixtures - skipped a
  //      legitimately-needed wiring pass.
  //   2. Hoisted package in monorepo workspaces produced a false
  //      "installed=false" verdict; downstream was off by one.
  //   3. A partial / corrupted wiring (init present, callback missing)
  //      can satisfy hasInit() but still be unusable.
  //
  // Cost: ~30-60s of AI time on re-runs that genuinely had nothing to
  // do. The AI is told to no-op if it finds a real wiring already in
  // place, so the bill is just turn-budget, not duplicate code.
  // `preExistingWiring` is purely informational - it shapes the progress
  // and success messages. Plugin-style wiring counts too (it has no
  // factory call, so isSdkWired alone can't see it).
  const preExistingWiring =
    isSdkWired(installDir, detectedLanguage) ||
    (isNext && nextPluginWiringStatus(installDir).ok);
  const inlineMode = ctx.keyDelivery === 'inline';
  debug.log('install-sdk.pre-existing-wiring', { preExistingWiring, installDir });

  // Wiring that existed BEFORE this run's AI pass, by style. A complete
  // manual (per-route) wiring from an earlier install keeps working on the
  // new SDK, so a plugin-style re-run must accept it rather than churn the
  // user's working setup into the plugin shape. Snapshot it here - after
  // the AI runs we can no longer tell "pre-existing" from "just written".
  const preNextStatus = isNext ? nextWiringStatus(installDir, nextInfo, detectedLanguage) : null;
  const preExistingManualNextWiring = !!preNextStatus && preNextStatus.wiredHandlerSide.length > 0;

  // The wiring gate. On Next.js, ANY middleware wiring fails regardless of
  // style. Then:
  //   - plugin style: pass on the plugin wiring (withRestless + restless
  //     config), OR on a manual wiring that predates this run (left alone).
  //   - manual style: pass when a handler-side factory wiring exists.
  // Elsewhere any factory-call file counts.
  const wiredNow = () => {
    if (!isNext) return isSdkWired(installDir, detectedLanguage);
    const status = nextWiringStatus(installDir, nextInfo, detectedLanguage);
    if (status.wiredMiddleware.length > 0) return false;
    if (nextStyle === 'plugin') {
      if (nextPluginWiringStatus(installDir).ok) return true;
      return preExistingManualNextWiring && status.wiredHandlerSide.length > 0;
    }
    return status.wiredHandlerSide.length > 0;
  };

  // Load the setup-sdk prompt once; retries re-use the base and append an
  // escalating coda telling the AI it must actually call Edit/Write.
  const guidePath = path.join(pkgRoot, 'docs', 'sdks', `${guideLanguage}.md`);
  const guide = fs.existsSync(guidePath) ? fs.readFileSync(guidePath, 'utf8') : '';
  const setupSection = guide.split(/^## Setup\n/m)[1]?.split(/^## Verify\n/m)[0] || guide;
  // Hand over the entry-file candidates and the route files instead of
  // making the model hunt for them. In the profiled run this step spent
  // ~33s on 10 `Read` turns and 3 `Bash ls` turns; prefilling the same text
  // is free (see `lib/inline-source.js`).
  const wiringSource = buildWiringSourceBlock(installDir, { languages: [guideLanguage] });
  debug.log('install-sdk.inlined-source', {
    files: wiringSource.included.length,
    bytes: wiringSource.bytes,
    omitted: wiringSource.omitted.length,
  });
  const basePrompt = loadPromptForLanguage('setup-sdk', guideLanguage, {
    language: detectedLanguage,
    framework: detectedFramework || detectedLanguage,
    guide: setupSection,
    sourceFiles: wiringSource.block,
  });

  // For Next.js, append the concrete files and the hard "never touch
  // middleware" rule on top of the guide. The guide's Next.js sections
  // explain both patterns; this coda pins the chosen one to THIS project.
  const mwLabels = nextInfo.middlewareFiles.length
    ? nextInfo.middlewareFiles.map((f) => `\`${f}\``).join(', ')
    : '`middleware.ts` / `proxy.ts`';
  const mwHardRule =
    `HARD RULE: do NOT edit ${mwLabels}. Next hands middleware a request whose \`.request\` getter ` +
    `throws PageSignatureError (E394), and middleware runs on the Edge runtime where an \`owner.enrich\` ` +
    `DB lookup can't run. If a previous attempt wired the SDK into a middleware/proxy file, REMOVE it.`;

  // Plugin style: the single-config integration. The two files it consists
  // of, resolved against this project.
  const existingNextConfig = isNext ? findNextConfigFile(installDir) : null;
  const nextConfigLabel = existingNextConfig
    ? `\`${existingNextConfig}\` (this project's existing Next config - EDIT it, keep every current option)`
    : '`next.config.mjs` (this project has no Next config yet - CREATE it)';
  const restlessConfigName = guideLanguage === 'typescript' ? 'restless.config.ts' : 'restless.config.mjs';

  const pluginCoda =
    `\n\n## This is a Next.js App Router project (READ THIS)\n\n` +
    `Wire capture with the SDK's single-config Next.js integration. Exactly TWO files change; ` +
    `route files are NOT touched.\n` +
    `1. Wrap the exported Next config with \`withRestless\` in ${nextConfigLabel}:\n` +
    `   \`\`\`ts\n` +
    `   import { withRestless } from '@restlessai/sdk/next';\n` +
    `   const nextConfig = { /* existing config, unchanged */ };\n` +
    `   export default withRestless(nextConfig);\n` +
    `   \`\`\`\n` +
    `   \`withRestless\` composes with object, function, and async config forms - wrap whatever is ` +
    `exported today. For a CommonJS \`next.config.js\`, use ` +
    `\`const { withRestless } = require('@restlessai/sdk/next');\` and ` +
    `\`module.exports = withRestless(nextConfig);\`.\n` +
    `2. Create \`${restlessConfigName}\` at the project root (same directory as the Next config):\n` +
    `   \`\`\`ts\n` +
    `   import { defineConfig, mask } from '@restlessai/sdk/next';\n` +
    `\n` +
    `   export default defineConfig({\n` +
    `     setup: async (req) => ({\n` +
    `       apiKey: mask(/* credential extracted from req */),\n` +
    `       owner: { /* id, enrich - resolve per the guide above */ },\n` +
    `     }),\n` +
    `   });\n` +
    `   \`\`\`\n` +
    `   \`req\` is a standard Web \`Request\` - read the credential with \`req.headers.get('authorization')\`, ` +
    `not Express's \`req.headers.authorization\`. Every apiKey / owner.id / enrich rule from the guide ` +
    `applies to this callback exactly as written (\`mask\` is the named export here, not a client method).\n` +
    `   CRITICAL: import auth/DB helpers LAZILY inside the setup callback ` +
    `(\`const { getSession } = await import('@/lib/auth')\`), never at the top of the file. ` +
    `restless.config is bundled into every route's server chunk and \`next build\` evaluates route ` +
    `modules while collecting page data - a top-level import of DB-backed code breaks the build.\n` +
    `3. Do NOT edit any route file and do NOT wrap handlers by hand (\`export const GET = wrap(...)\`) - ` +
    `the plugin auto-wraps every \`app/**/route.*\` handler at build time. Exception: if this project ` +
    `ALREADY has a complete per-route wiring from an earlier install (a shared client calling ` +
    `\`restless(...)\` from \`@restlessai/sdk/next\` plus wrapped handlers), leave ALL of it alone and ` +
    `end the run - that wiring still works and must not be migrated or duplicated.\n` +
    `4. ${mwHardRule}\n` +
    `5. There is NO SDK init line in this integration - do not write \`restless(process.env.RESTLESS_KEY)\` ` +
    `anywhere and do not put an API key in any file. The SDK reads \`RESTLESS_KEY\` from the environment ` +
    `at runtime by itself.`;

  // Manual style: wrap route handlers by hand. Pages Router always;
  // App Router only when the installed Next predates auto-wrap support.
  const manualWrapExample = nextInfo.router === 'pages'
    ? `   \`\`\`ts\n` +
      `   export default wrap(existingHandler);\n` +
      `   \`\`\`\n` +
      `   (Pages Router files export ONE default handler taking \`NextApiRequest\`/\`NextApiResponse\`; ` +
      `read the credential off \`req.headers.authorization\`.)\n`
    : `   \`\`\`ts\n` +
      `   export const GET = wrap(existingGetHandler);\n` +
      `   export const POST = wrap(existingPostHandler);\n` +
      `   \`\`\`\n`;
  const manualCoda =
    `\n\n## This is a Next.js ${nextInfo.router === 'pages' ? 'Pages Router' : 'App Router'} project (READ THIS)\n\n` +
    (nextStyle === 'manual' && nextInfo.router === 'app' && autoWrap.reason
      ? `(The single-config \`withRestless\` integration is NOT available here: ${autoWrap.reason}. ` +
        `Use the manual per-route wrapping below instead - do not add \`withRestless\` to the Next config.)\n\n`
      : '') +
    `Wire capture by WRAPPING route handlers with \`@restlessai/sdk/next\`. Do NOT register middleware.\n` +
    `1. Create one shared client module (e.g. \`lib/restless.ts\` next to the routes):\n` +
    `   \`\`\`ts\n` +
    `   import restless from '@restlessai/sdk/next';\n` +
    `   export const client = restless(process.env.RESTLESS_KEY);\n` +
    `   export const wrap = client.setup(async (req) => ({ /* apiKey, owner */ }));\n` +
    `   \`\`\`\n` +
    `   \`client.setup(cb)\` returns a handler-wrapper \`(handler) => handler\` - it is NOT middleware.\n` +
    `2. In each route file, wrap every exported HTTP handler with \`wrap(...)\`:\n` +
    manualWrapExample +
    `   Route handler files to wrap:\n` +
    nextInfo.routeHandlerFiles.map((f) => `   - \`${f}\``).join('\n') + `\n` +
    `3. ${mwHardRule}\n` +
    `4. Import from \`@restlessai/sdk/next\` (NOT bare \`@restlessai/sdk\`) and pass \`process.env.RESTLESS_KEY\`.`;

  const nextCoda = !isNext ? '' : (nextStyle === 'plugin' ? pluginCoda : manualCoda);

  // The AI's job is to wire the SDK into the right entry file with
  // sentinel-bracketed comments and `process.env.RESTLESS_KEY` as a
  // placeholder. The CLI takes ownership of the init line afterwards
  // (canonicalizeSdkBlock below) so the AI never has to reason about
  // env loaders or key delivery modes.
  //
  // `attemptNum` 1 = first pass (base prompt). 2 = blind retry with a
  // "you didn't write — you MUST call Edit" coda. 3 = retry with a
  // user-supplied entry file path baked in.
  const aiActivity = { edited: new Set(), denied: new Set() };
  const recordAiReport = ({ edited = [], denied = [] } = {}) => {
    for (const p of edited) aiActivity.edited.add(p);
    for (const p of denied) aiActivity.denied.add(p);
  };
  const activityLines = () =>
    describeAiActivity({ edited: [...aiActivity.edited], denied: [...aiActivity.denied] }, installDir, aiTool);

  async function runSetupAi(attemptNum, userHint = null) {
    let prompt = basePrompt + nextCoda;
    if (attemptNum > 1 && isNext) {
      // Next retries: name the exact failure so the AI can correct it.
      // Middleware wiring trumps everything; then, per style, either the
      // missing plugin piece (withRestless / restless.config) or the
      // missing handler wraps.
      const status = nextWiringStatus(installDir, nextInfo, detectedLanguage);
      const plugin = nextStyle === 'plugin' ? nextPluginWiringStatus(installDir) : null;
      if (status.wiredMiddleware.length) {
        const fixInstruction = nextStyle === 'plugin'
          ? `REMOVE the SDK from that file, then apply the single-config integration described above ` +
            `(\`withRestless\` in the Next config + \`${restlessConfigName}\`).`
          : `REMOVE the SDK from that file, then wrap the route handlers above with \`wrap(...)\` from \`@restlessai/sdk/next\`.`;
        prompt += `\n\n## Retry context (READ THIS)\n\n` +
          `Your previous attempt wired the SDK into ${status.wiredMiddleware.map((f) => `\`${f}\``).join(', ')}, ` +
          `which is a Next.js middleware file. That crashes at runtime with PageSignatureError (E394). ` +
          fixInstruction;
      } else if (plugin && !plugin.hasWithRestless) {
        // Name the config file as it exists NOW - the previous attempt may
        // have created one - not the pre-run snapshot in nextConfigLabel.
        const configTarget = plugin.nextConfigFile
          ? `\`${plugin.nextConfigFile}\``
          : '`next.config.mjs` (create it - this project has no Next config)';
        prompt += `\n\n## Retry context (READ THIS)\n\n` +
          `Your previous attempt did not wrap the Next config export with \`withRestless\`. You MUST use ` +
          `the Edit (or Write) tool on ${configTarget} so its exported config is wrapped: ` +
          `\`export default withRestless(nextConfig);\` (with the \`withRestless\` import from ` +
          `\`@restlessai/sdk/next\`). Producing text describing the change is not enough — apply it.`;
      } else if (plugin && !plugin.hasDefineConfig) {
        prompt += `\n\n## Retry context (READ THIS)\n\n` +
          `The Next config is wrapped with \`withRestless\`, but \`${restlessConfigName}\` is missing or ` +
          `does not call \`defineConfig\`. You MUST use the Write tool to create it at the project root ` +
          `exactly as described in step 2 above (\`defineConfig\` + \`mask\` imported from ` +
          `\`@restlessai/sdk/next\`). Producing text describing the change is not enough — apply it.`;
      } else {
        prompt += `\n\n## Retry context (READ THIS)\n\n` +
          `Your previous attempt did not wrap any route handlers. You MUST use the Edit (or Write) tool ` +
          `to wrap the exported handlers in the route files listed above with \`wrap(...)\` from ` +
          `\`@restlessai/sdk/next\`. Producing text describing the change is not enough — apply it.`;
      }
    } else if (attemptNum > 1) {
      const previous = aiActivity.denied.size
        ? `Your previous attempt tried to edit files outside this project, which was refused. ` +
          `The project is at \`${installDir}\`: make every change there. `
        : aiActivity.edited.size
          ? `Your previous attempt edited files but did not wire the SDK in. `
          : `Your previous attempt produced commentary but did not modify any files. `;
      prompt += `\n\n## Retry context (READ THIS)\n\n` +
        previous +
        `Source files in this project still contain no \`@restlessai/sdk\` import. ` +
        `You MUST use the Edit (or Write) tool to add the SDK middleware to the user's ` +
        `server entry file. Producing text describing the change is not enough — apply it.`;
      if (userHint) {
        prompt += `\n\nThe user has told us the server entry file is at: \`${userHint}\`. ` +
          `Open that file with Read first, then use Edit to wire the SDK in there.`;
      } else {
        prompt += `\n\nIf you couldn't find the entry file before, search again. Try these names ` +
          `at the project root and one level deep: \`server.{js,ts,mjs,cjs}\`, \`index.{js,ts,mjs,cjs}\`, ` +
          `\`app.{js,ts,mjs,cjs}\`, \`main.{js,ts,mjs,cjs}\`, plus the same inside \`src/\`. ` +
          `If \`package.json\` has a "main" or "start" script pointing at a file, use that one.`;
      }
    }
    debug.log('install-sdk.ai-attempt', { attempt: attemptNum, hint: userHint || null });
    try {
      await runAI(prompt, installDir, {
        setSpinner,
        label: `setup-sdk:attempt-${attemptNum}`,
        onReport: recordAiReport,
      });
    } catch (err) {
      // Don't bail on a per-attempt error — the retry loop is the recovery
      // path. The final `fatalError` below covers the case where every
      // attempt either errored or produced no write.
      debug.log('install-sdk.ai-error', { attempt: attemptNum, message: err.message });
    }
  }

  // Always run the AI - no "looks wired, skip" shortcut. The AI is
  // told (in the prompt) to leave an existing complete wiring alone.
  // The retry loop below catches "AI didn't write" cases regardless of
  // whether wiring pre-existed.
  if (preExistingWiring) {
    update({ activeSub: 2, message: [
      `  Re-checking the ${bold(sdkName)} wiring in your ${bold(detectedFramework || detectedLanguage)} code.`,
      `  ${orange(aiTool)} ${dim("is looking at what's there and adding anything missing.")}`,
    ]});
  } else if (isNext && nextStyle === 'plugin') {
    update({ activeSub: 2, message: [
      `  Wiring ${bold('@restlessai/sdk/next')} into your ${bold(detectedFramework || 'Next.js')} config.`,
      `  ${orange(aiTool)} ${dim(`is adding ${bold('withRestless')} to your Next config and creating ${bold(restlessConfigName)}.`)}`,
      dim(`  Your route files stay untouched - the SDK wraps them at build time.`),
    ]});
  } else if (isNext) {
    update({ activeSub: 2, message: [
      `  Wiring ${bold('@restlessai/sdk/next')} into your ${bold(detectedFramework || 'Next.js')} routes.`,
      `  ${orange(aiTool)} ${dim("is wrapping your route handlers - it won't touch middleware.")}`,
    ]});
  } else {
    update({ activeSub: 2, message: [
      `  Wiring ${bold(sdkName)} into your ${bold(detectedFramework || detectedLanguage)} code.`,
      `  ${orange(aiTool)} ${dim('is reading your server file and registering the middleware before routes.')}`,
    ]});
  }

  await runSetupAi(1);

  // Retry loop: if the first pass produced no write AND the SDK isn't
  // wired in (i.e. the AI didn't either fix it OR confirm a pre-
  // existing wiring), escalate. Attempt 2 is a blind retry with a
  // stronger prompt; attempt 3 asks the user for the entry-file path
  // and bakes it in. After that, we give up and bail.
  {
    let attempt = 1;
    while (!wiredNow() && attempt < 3) {
      attempt++;
      if (isNext) {
        // Next.js retries stay blind - there's no single "entry file" to ask
        // about; the coda already names the exact route files to wrap and the
        // middleware files to leave alone.
        const status = nextWiringStatus(installDir, nextInfo, detectedLanguage);
        let retryMessage;
        if (status.wiredMiddleware.length) {
          retryMessage = [
            `  ${yellow('⚠')} ${orange(aiTool)} wired the SDK into ${bold(status.wiredMiddleware[0])} (Next middleware). Trying again.`,
            dim(nextStyle === 'plugin'
              ? '  Telling it to move the wiring into the Next config instead.'
              : '  Telling it to move the wiring onto the route handlers instead.'),
          ];
        } else if (nextStyle === 'plugin') {
          const plugin = nextPluginWiringStatus(installDir);
          retryMessage = !plugin.hasWithRestless
            ? [
              `  ${yellow('⚠')} ${orange(aiTool)} finished without adding ${bold('withRestless')} to your Next config. Trying again.`,
              dim('  Giving it an explicit instruction to wrap the config export this time.'),
            ]
            : [
              `  ${yellow('⚠')} ${orange(aiTool)} finished without creating ${bold(restlessConfigName)}. Trying again.`,
              dim('  Giving it an explicit instruction to write the capture config this time.'),
            ];
        } else {
          retryMessage = [
            `  ${yellow('⚠')} ${orange(aiTool)} finished without wrapping any route handlers. Trying again.`,
            dim('  Giving it an explicit instruction to wrap the routes this time.'),
          ];
        }
        update({ activeSub: 2, message: retryMessage });
        await runSetupAi(attempt);
      } else if (attempt === 2) {
        update({ activeSub: 2, message: [
          ...activityLines().map((l) => `  ${yellow('⚠')} ${l}`),
          dim('  Trying again with an explicit instruction to use the Edit tool.'),
        ]});
        await runSetupAi(2);
      } else {
        // Attempt 3: ask the user where the entry file lives.
        update({ activeSub: 2, message: [
          `  ${yellow('⚠')} Two passes done and the SDK still isn't wired in.`,
          dim("  Sometimes the AI can't locate the right entry file."),
          dim('  Point us at it and we\'ll try once more.'),
          '',
          dim('  e.g. src/server.ts, index.js, app.js'),
          dim('  Press Enter to skip and let us try blind one more time.'),
        ]});
        const raw = (await ask('  Entry file path: ')).trim();

        // Light sanity check. If the user typed a path that doesn't exist,
        // mention it and continue without the hint — better than passing
        // a bogus path to the AI.
        let validatedHint = null;
        if (raw) {
          const abs = path.isAbsolute(raw) ? raw : path.join(installDir, raw);
          if (fs.existsSync(abs)) {
            validatedHint = path.relative(installDir, abs) || raw;
          } else {
            update({ activeSub: 2, message: [
              `  ${yellow('⚠')} ${cyan(raw)} doesn't exist under ${bold(installDirRel)}. Trying without the hint.`,
            ]});
          }
        }

        update({ activeSub: 2, message: [
          validatedHint
            ? `  Retrying with hint: ${cyan(validatedHint)}`
            : `  Retrying one more time.`,
        ]});
        await runSetupAi(3, validatedHint);
      }
    }
  }

  const nowWired = wiredNow();
  debug.log('install-sdk.now-wired', { nowWired, installDir, isNext });

  if (!nowWired) {
    // Hard stop. Every downstream step (test-setup, redaction, setup-account)
    // assumes the SDK is wired in. Bail loudly instead of pushing the user
    // into a test step that can never succeed.
    debug.log('install-sdk.gave-up', { installDir, language: detectedLanguage, isNext });
    if (isNext) {
      // Distinguish "wired the wrong place" from "wrote nothing" so the
      // manual-fix advice is actionable - and name the right fix for the
      // wiring style we were installing.
      const status = nextWiringStatus(installDir, nextInfo, detectedLanguage);
      let detail;
      if (status.wiredMiddleware.length) {
        detail = [
          `${aiTool} kept wiring the SDK into ${status.wiredMiddleware.map((f) => bold(f)).join(', ')},`,
          `a Next.js middleware file. That crashes with PageSignatureError on the Edge runtime.`,
        ];
      } else if (nextStyle === 'plugin') {
        const plugin = nextPluginWiringStatus(installDir);
        detail = !plugin.hasWithRestless
          ? [`${aiTool} read your project but never added ${bold('withRestless')} to your Next config, even after retries.`]
          : [`${aiTool} wrapped your Next config but never wrote a valid ${bold(restlessConfigName)}, even after retries.`];
      } else {
        detail = [`${aiTool} read your project but never wrapped a route handler, even after retries.`];
      }
      const manualFix = nextStyle === 'plugin'
        ? [
          `Set it up by hand with the guide \`npx ${CLI_NAME} guide ${guideLanguage}\` prints (the Next.js`,
          `App Router section): wrap your Next config with ${bold('withRestless')} and create ${bold(restlessConfigName)}.`,
        ]
        : [
          `Wrap your route handlers by hand with the guide \`npx ${CLI_NAME} guide ${guideLanguage}\``,
          `prints (the Next.js section), then re-run \`npx ${CLI_NAME} init\`.`,
        ];
      fatalError(
        "We couldn't wire the SDK into your Next.js project automatically.",
        [
          ...detail,
          ...(aiActivity.denied.size ? activityLines().slice(0, 1) : []),
          ...manualFix,
          '',
          `Run \`npx ${CLI_NAME} submit-debug\` to send us this run's log.`,
        ],
      );
      return { detectedLanguage, detectedFramework, guideLanguage, installed: true, wired: false };
    }
    fatalError(
      "We couldn't wire the SDK into your code automatically.",
      [
        ...activityLines(),
        `Install the SDK by hand with the guide \`npx ${CLI_NAME} guide ${guideLanguage}\` prints,`,
        `then re-run \`npx ${CLI_NAME} init\`.`,
        '',
        `Run \`npx ${CLI_NAME} submit-debug\` to send us this run's log.`,
      ],
    );
    // Unreachable: fatalError throws FatalExit.
    return { detectedLanguage, detectedFramework, guideLanguage, installed: true, wired: false };
  }

  // CLI takes over: canonicalize the init line based on ctx.sdkLineSpec.
  // Runs every time (fresh install AND re-runs) so a previous broken
  // state can be repaired without another AI call.
  //
  // Plugin-style Next wiring has no init line to canonicalize (the SDK
  // reads RESTLESS_KEY from the environment), so canonicalize comes back
  // 'no-source' there. Point entryFile at restless.config.* instead -
  // that's where the setup callback (credential + owner.id) lives, and
  // it's what verify-owner-id / final-checks need to read.
  const canon = canonicalizeSdkBlock(ctx);
  ctx.sdkBlockPresent = true;
  ctx.entryFile = canon.file;
  if (!ctx.entryFile && isNext && nextStyle === 'plugin') {
    const plugin = nextPluginWiringStatus(installDir);
    if (plugin.hasDefineConfig) ctx.entryFile = plugin.restlessConfigFile;
  }

  const headerLine = preExistingWiring
    ? `  ${green('✓')} SDK wiring confirmed - left existing setup alone.`
    : `  ${green('✓')} SDK installed and configured.`;
  const baseMsg = [headerLine];
  if (inlineMode && canon.mode === 'canonicalized') {
    baseMsg.push(dim(`  Inlined the API key in ${bold(canon.file)} - testing only, don't commit.`));
  }
  // Stay on 'Configure SDK' (sub 2) - the owner.id verification the
  // caller runs next is part of this row, not the next one.
  update({ sub: { 0: 'done', 1: 'done' }, activeSub: 2, message: baseMsg });

  return {
    detectedLanguage,
    detectedFramework,
    guideLanguage,
    installed: true,
    wired: wiredNow(),
    installDir,
    // Surface whatever the caller's prepareAccountStep produced so api.js
    // can use the apiKey / projectId / setupKey downstream (testSetup,
    // setupAccount, etc.).
    prepareResult,
  };
}
