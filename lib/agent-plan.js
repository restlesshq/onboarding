import fs from 'fs';
import path from 'path';
import { loadSettings } from './settings.js';
import { findFrameworkSignals } from './find-endpoints.js';
import { countOperations } from './oas-parse.js';
import { getSdkWriter } from './sdk-writers/index.js';
import { normalizeLanguage } from './sdk-writers/languages.js';
import { formatPathList } from './sdk-writers/contract.js';
import { installCommandFor } from './install-target.js';

/**
 * The playbook `npx restless init` prints when a coding agent is driving it.
 *
 * The alternative - and what the CLI used to do in this situation - is to
 * spawn its own model and edit the user's code from inside a child process.
 * That works, but from the caller's seat it's a black box: no diffs, no way
 * to steer it, no way to tell a stuck run from a slow one, and a second
 * agent reasoning about a repo the calling agent already understands.
 *
 * So when an agent is detected we stop being an actor and become a
 * toolkit: state what we know about the repo, hand over the same guides our
 * own model would have used, and name the deterministic commands worth
 * calling back into. The agent does the code work in the open, where the
 * user can watch and interrupt it.
 *
 * What stays ours (and why): key generation and project registration
 * (credentials, plus a server round-trip), the shape of the SDK init line
 * (it has a canonical form the CLI repairs on every run), and the runtime
 * check (it reads response headers the agent shouldn't have to parse).
 * Everything else - reading the code, writing the spec, wiring middleware -
 * is exactly what the calling agent is already good at.
 */

function countEndpoints(absPath) {
  try {
    return countOperations(JSON.parse(fs.readFileSync(absPath, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * What we can say about this repo without running a model: which APIs are
 * already mapped, and what the deterministic scan found. Keeps the playbook
 * concrete ("wire benefits-api/index.js") instead of generic.
 */
export function repoFacts({ rootDir, signals }) {
  const settings = loadSettings(rootDir);
  const mapped = [];
  for (const api of settings.apis || []) {
    if (!api.oasFile) continue;
    const abs = path.join(rootDir, api.oasFile);
    if (!fs.existsSync(abs)) continue;
    mapped.push({
      name: api.name,
      oasFile: api.oasFile,
      rootDir: api.rootDir || '.',
      framework: api.framework || null,
      language: api.language || null,
      projectId: api.projectId || null,
      endpoints: countEndpoints(abs),
    });
  }
  // Only scan when nothing is mapped: mapped facts win the rendering anyway,
  // and skipping the walk keeps re-runs instant. Callers (tests) can still
  // inject signals explicitly.
  if (!signals) signals = mapped.length ? [] : scanForSignals(rootDir);
  return { mapped, signals };
}

/** The deterministic framework scan, downgraded to "no facts" on any error. */
function scanForSignals(rootDir) {
  try {
    return findFrameworkSignals(rootDir);
  } catch {
    return [];
  }
}

function facts({ mapped, signals }) {
  const lines = [];
  if (mapped.length) {
    lines.push('Already mapped in `.restless/` (from a previous run):');
    for (const m of mapped) {
      const bits = [
        m.endpoints === null ? 'unreadable spec' : `${m.endpoints} endpoints`,
        m.framework || m.language,
        m.rootDir === '.' ? './' : `./${m.rootDir}`,
      ].filter(Boolean);
      lines.push(`- **${m.name}** - \`${m.oasFile}\` (${bits.join(', ')})`);
    }
    lines.push('');
    lines.push('If the user wants one of these set up again, reuse the spec instead of regenerating it. Only re-map an API whose spec is missing, unreadable, or out of date with the code.');
  } else if (signals.length) {
    lines.push('Found by a deterministic scan of dependencies and source (no model involved, so verify before trusting):');
    for (const s of signals.slice(0, 6)) {
      const where = s.package === '.' ? './' : `./${s.package}/`;
      const framework = (s.frameworkDeps?.length ? s.frameworkDeps : s.sourceMarkers || []).join(', ');
      const bits = [];
      if (framework) bits.push(framework);
      if (s.endpointCount) bits.push(`${s.endpointCount} route${s.endpointCount === 1 ? '' : 's'} spotted inline`);
      if (s.oasGenDeps?.length) bits.push(`can generate its own spec via ${s.oasGenDeps.join(', ')}`);
      lines.push(`- \`${where}\`${s.name ? ` (${s.name})` : ''}${bits.length ? ` - ${bits.join('; ')}` : ''}`);
    }
    if (signals.length > 6) lines.push(`- ...and ${signals.length - 6} more.`);
    if (signals.length > 1) {
      lines.push('');
      lines.push('More than one API candidate. Ask the user which one to set up before starting - do not pick for them.');
    }
  } else {
    lines.push('Nothing is mapped yet, and a scan of dependencies and source found no framework it recognizes. Find the API yourself before starting.');
  }
  return lines.join('\n');
}

/**
 * Build the playbook. `cli` is how the user invoked us (`api`, `api-beta`),
 * so the commands we print are the ones that actually exist on their PATH.
 *
 * `agentSlug` is the agent's machine name when we know it. Null means we can
 * tell an agent is driving but not which - only Claude Code and Codex export
 * a marker we recognize - so the plan asks the reader to identify itself on
 * the one command where it matters (step 2 registers the project).
 */
/**
 * Per-language phrasing for the playbook.
 *
 * The install command comes off the writer descriptor rather than being
 * written out again here, so there is one place that knows what to run.
 */
function languageNotes(languages) {
  const langs = (languages && languages.length ? languages : ['javascript']).map(normalizeLanguage);
  // The non-JS language wins when a repo has both: a Django or Rails API
  // behind a Next.js frontend is set up as the API, and the playbook should
  // describe the ecosystem the reader is about to install into.
  const primary = langs.find((l) => l !== 'javascript' && l !== 'typescript') || langs[0] || 'javascript';
  const installs = [...new Set(langs.map((l) => installCommandFor(l)))];
  // Just the two an agent will actually recognise. The full list is the
  // walk's business, not the reader's.
  const manifests = [...new Set(langs.flatMap((l) => getSdkWriter(l).descriptor.manifests))].slice(0, 2);

  return {
    install: installs.join('`, or `'),
    manifestList: manifests.join('` / `'),
    // Union across every detected language, off the descriptors. In a
    // Django-behind-Next repo both trees are present and the agent should
    // stay out of both, and sourcing it here means this line and the
    // `{{neverRead}}` substitution in `lib/ai.js` cannot drift apart.
    neverRead: formatPathList([
      ...new Set(langs.flatMap((l) => getSdkWriter(l).descriptor.neverRead)),
    ]),
    // The ecosystem-specific prose. Off the primary language's descriptor
    // rather than a local table, so a new writer brings its own phrasing and
    // there is no `PHRASING[primary] || PHRASING.javascript` fallback quietly
    // describing npm to a Rails developer.
    ...getSdkWriter(primary).descriptor.phrasing,
  };
}

export function buildAgentPlan({ rootDir, cli = 'restless', agent = 'your agent', agentSlug = null, languages = ['javascript'] }) {
  const lang = languageNotes(languages);
  const { mapped, signals } = repoFacts({ rootDir });
  const npx = (cmd) => `npx ${cli} ${cmd}`;
  const identify = agentSlug
    ? ''
    : `\n   You're an agent we can't identify from the environment, so add
   \`--agent <your-name>\` (lowercase, e.g. \`--agent cursor\`) to name yourself -
   it records which agent set the project up. Use the tool's own name, and
   nothing about the user or this repo.\n`;

  return `# Restless setup - instructions for ${agent}

You ran \`${npx('init')}\` inside a coding agent. Rather than editing this repo from
a hidden sub-agent, here is the whole job so you can do it in the open, where the
user can see the diffs and stop you.

Work through the steps in order. Each one says what to do and which command to
call for the parts you should not hand-roll.

Before touching anything, tell the user the plan in a few lines - map the API
into a spec, wire in the SDK, prove a request lands, hand them a claim link - so
they know what's coming and can redirect you early.

## What we already know

${facts({ mapped, signals })}

## Step 1 - map the API to an OpenAPI spec

Goal: \`.restless/openapi.json\` describing every endpoint the server exposes.

1. Run \`${npx('guide oas')}\` and follow it. It is the same instruction set the CLI's
   own model uses: required fields, path coverage, the exact output location.
2. **Check whether the project can generate the spec itself first.** If it already
   has \`@fastify/swagger\`, NestJS's Swagger module, drf-spectacular, FastAPI's
   \`/openapi.json\`, or a committed spec that is merely stale, that output beats
   anything inferred by reading routes. Run it, or point at what exists.
3. Otherwise read the routes and write the spec. Don't guess from folder names,
   and don't drop endpoints to save room - coverage gets checked later.
4. **\`servers[0].url\` is the API's PUBLIC base URL - never a local address.** The
   spec is uploaded to the dashboard, so localhost, 127.0.0.1, container hostnames,
   and dev ports must not appear in it; \`${npx('register')}\` rejects them. The
   \`${npx('guide oas')}\` output includes our best deterministic guess from deploy
   config and the README - verify it against the code, and include any mount
   prefix (\`/api\`, \`/v1\`). Can't confirm a public URL? Ask the user. The user says
   there isn't one? Use a relative mount path like \`/\` or \`/v1\`. The local dev
   address belongs in step 3's \`verify --url\`, never in the spec.
5. Register it so the SDK and later commands can find it:

   \`\`\`
   ${npx(`register --oas .restless/openapi.json --dir <dir-with-${lang.manifestList.split('` / `')[0]}> --name "<API name>"`)}
   \`\`\`

Never read \`.env\` files or anything under ${lang.neverRead} while doing this. If you
need the port and it only exists in \`.env\`, ask the user rather than opening it.

## Step 2 - install and wire the SDK

1. Get the project's key. This one is ours: it generates the key, registers the
   project, and writes \`RESTLESS_KEY\` to the right \`.env\`:

   \`\`\`
   ${npx('key --json')}
   \`\`\`
${identify}
   It prints \`{ "projectId": "...", "envFile": "...", "envIgnoredByGit": ... }\`. The key
   itself never appears in your output - it goes straight into the env file named
   there. Do not invent a key, and do not read it back out of \`.env\`. If
   \`envIgnoredByGit\` is \`false\`, tell the user their env file is not in
   \`.gitignore\` before anything gets committed - do not edit \`.gitignore\` yourself.
2. Install the SDK: \`${lang.install}\` (or the project's package manager) in the
   directory that owns the server's ${lang.manifestList.includes('/') ? `\`${lang.manifestList}\`` : `\`${lang.manifestList}\``}.
3. Run \`${npx('guide sdk')}\` and follow it exactly. The critical part is *where* the
   middleware goes: above every guard that can reject a request, so the SDK still
   sees a 401. The guide covers each framework, the \`owner.id\` rules, and the
   \`sdk.mask()\` gotchas.
4. If you could not find a stable owner id and used the guide's
   \`NEEDS_CONFIGURATION\` placeholder, stop and ask the user which field is the
   permanent owner id, then replace it. Step 3's check fails while the
   placeholder is anywhere in the code - a placeholder that ships collapses
   every customer into one fake owner, permanently.

## Step 3 - prove it works

Start the server yourself, in the background, the way the project normally starts
(${lang.startHints}). ${lang.envNote} Only hand this to the
user if you genuinely can't run it (a database you can't provide, secrets, docker):
then ask them to start it in another terminal and wait for their go-ahead.

Once it's listening, point the check at the base URL you established in step 1
(host, port, and any mount prefix - don't assume \`:3000\`, and if the app is
containerized use the published port, not the internal one):

\`\`\`
${npx('verify --url http://localhost:<port> --path /<an-existing-route> --json')}
\`\`\`

It sends a real request and reads the response headers, reporting one of:

- \`ok\` - the SDK saw the request. Done.
- \`no-sdk\` - the request never reached the SDK. Almost always middleware order:
  something above it answered first. Fix the order and re-run.
- \`no-key\` - the SDK ran but \`RESTLESS_KEY\` is not in the server's environment.
  Usually the server needs a restart, or it does not load \`.env\`.
- \`stale-key\` - the SDK captured and uploaded the request, but nothing arrived in
  the registered project: the running key maps to an older project. Run
  \`${npx('key')}\` to reconcile, restart the server, and re-check.
- \`setup-expired\` - the SDK captured the request, but this setup's own key has
  expired so the dashboard check could not run. Run \`${npx('login')}\` to refresh it.
- \`unreachable\` - nothing is listening. Check the port with the user.

A non-2xx status is fine here. A 401 that the SDK captured is a pass - capturing
rejected requests is the point.

The check also greps for the \`NEEDS_CONFIGURATION\` owner-id placeholder and
fails (\`ownerIdNeedsConfiguration: true\`) while it is still in the code - ask
the user for the real identifier, update the callback, and re-run.

If you started the server for this check, shut it down once the check passes -
don't leave an orphaned process running.

## Step 4 - let the user claim the project

\`\`\`
${npx('login')}
\`\`\`

Uploads the spec and settings to the dashboard, then prints a claim URL. Hand
that URL to the user - they open it, sign in, and the project becomes theirs.
Do not open a browser yourself.

**The claim link is the finish line, not a footnote.** Until the user opens it
and signs in, the project is unclaimed: logs are being collected, but they
aren't visible to anyone yet. The link also goes stale after a few hours
(re-run \`${npx('login')}\` for a fresh one). Say so plainly when you hand it
over - something like: "Last step: open this link to connect the project to
your account - that's where your logs show up." It is the one step you cannot
do for them.

Make the claim URL the LAST line of your wrap-up message. It is the user's one
next action; a recap below it buries it. Everything else you want to say goes
above the link.

## Rules

- \`.restless/\` is committed with the code. It is configuration the SDK reads at
  startup, not a cache. Never add it to \`.gitignore\`; include it in commits.
- \`.env\` holds the key and stays out of git. Never read it, never print it, and
  never stage or commit it. If \`${npx('key')}\` reported \`"envIgnoredByGit": false\`,
  warn the user and let them fix \`.gitignore\` themselves.
- Do not touch ${lang.dontTouch}.
- Keep the change small: the spec, the SDK wiring, and \`.restless/\`. (\`${npx('key')}\`
  changes \`.env\` too, but that file never goes in a commit.)

Prefer the guided experience? \`${npx('init --self-drive')}\` runs the original flow, where
the CLI does all of this itself.
`;
}
