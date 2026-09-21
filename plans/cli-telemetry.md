# Plan: anonymous usage telemetry in the `restless` CLI

Modelled on [Vercel CLI Telemetry](https://vercel.com/docs/cli/about-telemetry) and
[`vercel telemetry`](https://vercel.com/docs/cli/telemetry): opt-out, disclosed on first
run, enum-only payloads, a hard list of things that are never collected, and a
debug mode that prints the payload instead of sending it.

The server side is **not** covered here — see `plans/backend-telemetry.md`.

---

## 1. Why this shape

`init` is a long, multi-step flow that can fail in a dozen places (stack detection, AI
spec generation, SDK install, wiring verification, the test request). Today we find out
it failed only when someone tells us, or when they run `--debug` and upload a full log.
Telemetry answers the questions the debug log can't, because the debug log is opt-in and
one-at-a-time:

- which commands people actually run, and in what order across a week;
- how far `init` gets before it stops, by step;
- how much of a run is AI vs. install vs. waiting on the user (we already measure this in
  `lib/timings.js`, and today it dies with the process);
- what share of runs are agent-driven vs. human, and which agent;
- which Node versions / platforms we actually have to support.

None of that needs code, paths, prompts, or identities.

## 2. Precedent already in the repo

Follow these rather than inventing new conventions:

| Thing | Existing precedent |
| --- | --- |
| Fire-and-forget POST, bounded, failures swallowed | `trackDebugEvent` in `bin/restless.js:199` |
| One buffered payload flushed at exit, `{ meta, entries }` | `lib/debug.js` (`finalize`, `postDebugLog`) |
| User-global state in `~/.restless/` | `lib/cli-token.js:24` (`~/.restless/projects/`), `lib/debug.js` (`~/.restless/debug/`) |
| Env-var override of a directory, for tests | `RESTLESS_DEBUG_DIR` in `lib/debug.js` |
| Normalized enum instead of free text | `normalizeAgentName` / `AGENT_ALIASES` in `lib/env.js` |
| A JSON schema kept honest by a test | `schemas/settings.schema.json` + `tests/settings-schema.test.js` |
| Non-sensitive provenance already sent to the server | `setupProvenance` in `lib/project-init.js:43` |

The last row matters: we *already* send `setup_source` and `setup_agent` at registration,
and the README already discloses it. Telemetry is an extension of that posture, not a new
one.

### An endpoint we already have and do not call

`POST /api/projects/:projectId/setup-progress` exists in `restlesshq/app`, is tested, and
records per-step `init` funnel data (`welcome`, `generate_oas`, `install_sdk`, `test`,
`account` × `started|done|failed`) onto the durable `KeyRegistration` row. It is surfaced
to staff today at `/admin/unclaimed`.

**This CLI never calls it, and never sent the setup email either.** Both landed in
[restlesshq/app#240](https://github.com/restlesshq/app/pull/240) (merged 2026-08-15) as
the server half of a two-part change; the client half was never written. `registerProject`
in `lib/project-init.js` still sends only `write_key_hash` + provenance, and there is no
reference to `setup-progress` anywhere in this package.

That is worth fixing on its own, independently of this plan, and it changes the shape of
the `step` event below. The two mechanisms are not interchangeable: `setup-progress` is
authenticated with the setup key and joined to a project, so it answers "did *this*
customer stall"; telemetry is anonymous, so it answers "what fraction of all runs stall
here, on which Node version". Probably we want both. What we should not do is build a
second funnel in ignorance of the first.

If we wire up `setup-progress`, note it should report the full `SETUP_STEPS` set — it is
authenticated and joined to a project, so `welcome` and `account` are worth having there.
Telemetry sends a subset (§3), in the same spelling, so the two stay comparable.

## 3. What gets collected

**One request per run. One event type. Everything else is a property of the run.**

The first draft of this plan had five event types (`command`, `step`, `timings`, `detect`,
`error`). That was wrong: four of the five occur *exactly once per run*, which makes them
fields, not events. Only `step` is a genuine 1..n stream. Collapsing them removes four
schemas to validate, store, document, and defend, and makes the four cheapest queries
plain field aggregations instead of array unwinds.

### The one event: `step`

Emitted as each `init` plan step completes. **Three values**, spelled exactly as the
dashboard's `SETUP_STEPS` (`src/lib/setupProgress.ts`) — this is a strict subset of that
enum, not a second vocabulary, so a step name still means one thing in both systems:

| id | what it means |
| --- | --- |
| `generate_oas` | "Map your API" — found or generated the spec |
| `install_sdk` | "Install SDK" — package installed, key generated, SDK wired, final checks |
| `test` | "Test your setup" — a live request was seen |

Fields: `{ step, status, durationMs }`, `status` ∈ `started | done | failed` (the
dashboard's `SETUP_STATUSES`).

`SETUP_STEPS`' other two values, `welcome` and `account`, are deliberately **not** sent —
not because they don't matter, but because each is already measured somewhere better:

- **`welcome`** is redundant with the run document itself. Every `init` run produces one
  telemetry document, so "all `init` runs" is already the funnel's denominator, and it is
  a truer one than `welcome` — it counts the runs that died *before* the welcome screen
  too, which `welcome` by definition cannot.
- **`account`** is the claim, and claiming is precisely what creates a `Project` with a
  `metricsId` server-side. The dashboard already knows, with certainty and joined to a
  real identity, who completed. An anonymous, self-reported, best-effort copy of that is
  strictly worse data about the one step we already measure perfectly.

What is left is exactly the middle of the funnel: the three steps whose outcome is
visible *only* from the client, because a run that fails in them never reaches the server
at all. That is the entire reason this dataset exists.

At most 3 of these per run, and only for `init`. `update`, `context`, `debug` and the
agent commands emit none — their outcome is the whole story.

**This also simplifies the instrumentation.** The earlier draft said "one line per file in
`steps/`". That is unnecessary: `lib/runner.js` already owns the step lifecycle, already
emits `debug.log('step.start', ...)`, and already opens a timing span per step
(`lib/runner.js:346`). Hook it there — three call sites in one file (the fourth plan step,
"Set up account", is skipped), not nine modules.

### Run properties (`meta`)

Identity and dedupe:

| Field | Notes |
| --- | --- |
| `anonymousId` | Random UUID in `~/.restless/config.json`. **Not** derived from hostname, username, MAC, or cwd. |
| `sessionId` | Per run. Lets the server dedupe a retried flush. |
| `schemaVersion` | `1`. |

What was run:

| Field | Notes |
| --- | --- |
| `command` | Fixed allowlist matching the dispatch chain at `bin/restless.js:521`: `init`, `setup`, `supercharge`, `context`, `debug`, `update`, `guide`, `key`, `register`, `verify`, `login`, `claim`, `reset`, `clear`, `timings`, `submit-debug`, `telemetry`, `help`, `version`. Anything else → `unknown`. **Never raw `argv`.** |
| `flags[]` | Flag *names* only, short allowlist (below). **Never values.** |
| `outcome` | `ok \| error \| interrupted` |
| `exitCode` | |
| `errorCode` | Stable enum assigned at the raise site, only when `outcome: error`. Never a message, stack, or HTTP body. |
| `errorStep` | Which step it died in, when known. |
| `durationMs` | Wall clock. |
| `byKind` | `{ ai, exec, net, scan, wait, anim }` totals in ms, from `summarize(debug.snapshot())` (`lib/timings-report.js:171`). Totals only — **never span labels**, which are built at call time. |

Environment:

| Field | Notes |
| --- | --- |
| `cliVersion` | |
| `cliName` | `restless \| api \| other`. Answers whether ReadMe's `api` package is still dispatching to us. |
| `platform` | `process.platform` |
| `nodeVersion` | `process.version` |
| `ci` | `Boolean(process.env.CI)` |
| `source` | `cli \| agent`, from `invocationSource()` |
| `agent` | `detectAgent()` — already a normalized slug or `null` |

Detection, `init` only:

| Field | Notes |
| --- | --- |
| `language` | Allowlisted, from `lib/sdk-writers/languages.js` |
| `framework` | Allowlisted |
| `oasSourceKind` | The `oasSource.kind` enum already in `schemas/settings.schema.json`: `ai \| native \| found \| file \| url \| describe \| agent` |

These three are already sent to the server at registration — but only by runs that *reach*
registration. Sending them anonymously is what lets us see the ones that don't, which is
the whole point. They make the funnel cross-tabbable ("Ruby runs fail at `install_sdk`
three times as often"), and that is the first question anyone will ask of the funnel.

`flags[]` allowlist — kept deliberately short, to flags that change what the CLI *does*:
`--agent`, `--self-drive`, `--dir`, `--oas`, `--url`, `--project`, `--full`, `--refresh`,
`--dry-run`, `--debug`. Not `--yes`, `--json`, `--timings` — those describe how output is
shaped, not what ran. This is the easiest thing in the whole payload to cut if you want it
smaller; nothing in §7 of the backend plan depends on it.

### Deliberately not collected, though we could

Cut from the first draft because no question we have needs them, and a field is far easier
to add later than to remove once it is in a published privacy doc:

- `cpus`, `arch` — Vercel sends CPU count; we have no question that uses it.
- `ciVendor` — the `ci` boolean answers "how much of our usage is CI". Which CI does not
  change anything we would do.
- A separate `command` event, a `timings` event, a `detect` event, an `error` event — all
  once-per-run, now fields.

### Never collected

State this list verbatim in the docs and enforce it with a test:

- environment variable names or values
- file paths, including `cwd`, the git root, the repo name, and any git remote
- file contents, OpenAPI specs, or any fragment of either
- AI prompts, AI completions, or anything the model wrote
- error messages, stack traces, HTTP response bodies
- hostname, username, IP beyond whatever the edge sees on the request itself
- `RESTLESS_KEY`, setup keys, CLI tokens, request IDs
- project ids or account ids (see the open decision in §9)

Note this is strictly stronger than what `lib/debug.js` records locally — that file
deliberately captures `cwd`, `user`, and `hostname` (`lib/debug.js:69`) because it stays
on disk unless someone passes `--debug`. **The telemetry payload must be built
independently, not by filtering a debug snapshot**, so a future field added to the debug
log can never leak into telemetry by default.

### Volume

One HTTP request per CLI run, ~1 KB, at most 3 step entries. A developer running `init`,
having it fail, and re-running it three times produces four requests. There is no
per-keystroke, per-AI-turn, or per-file event, and there should never be one.

## 4. Opt-out and precedence

Resolved once, at startup, in this order — first match wins:

1. `RESTLESS_TELEMETRY_DEBUG=1` → collect, print each event to stderr prefixed
   `[telemetry]`, send **nothing**. (Vercel's `VERCEL_TELEMETRY_DEBUG` equivalent.)
2. `RESTLESS_TELEMETRY_DISABLED=1` → off for this run, stored state untouched.
3. `DO_NOT_TRACK=1` → off. Not something Vercel honors; it costs one line and it is the
   answer we would want given to us.
4. Stored `telemetry.enabled === false` in `~/.restless/config.json` → off.
5. `IS_LINKED_INSTALL` (`lib/config.js:50`) → off. Our own checkouts and `npm link`ed
   copies must not pollute the numbers. Overridable with `RESTLESS_TELEMETRY_FORCE=1` so
   we can still test the real path.
6. Otherwise → on.

CI runs stay **on** and are labelled `ci: true`, matching Vercel. They are real usage and
we want to know how much of it there is.

## 5. First-run notice

Printed once, when `~/.restless/config.json` has no `telemetry.notifiedAt`:

```
  Restless collects anonymous usage data (which command ran, whether it
  worked, how long it took). No code, paths, or prompts — ever.
  Opt out: npx restless telemetry disable · https://restless.ai/docs/telemetry
```

Rules:

- **stderr, dimmed, at the END of the run**, not the start. `init` owns the whole screen
  (`printLogo`, `animateLogoIn`, plan redraws in `lib/runner.js`); a banner printed first
  gets wiped by the next `\x1b[H\x1b[J`, and a banner printed into the middle of the frame
  corrupts it. End-of-run on stderr is the only slot that is safe on every path.
- Emitted from the same flush hook as the send, so every exit path covers it.
- `notifiedAt` is written even when the run is non-interactive; an agent will not read it,
  but the human whose machine it is gets it once and we do not nag on every run.

## 6. The `telemetry` command

`npx restless telemetry <status|enable|disable>`, mirroring Vercel.

- `status` — prints on/off, why (which rule in §4 won), the `anonymousId`, and the
  endpoint. Useful in a support thread.
- `enable` / `disable` — write `telemetry.enabled` to `~/.restless/config.json` and
  confirm in one line.
- Bare `telemetry` → same as `status`.
- Unknown subcommand → usage line, exit 1.

`disable` should also drop the buffered events for the run in which it was called.

## 7. Transport

- `POST ${SITE_URL}/api/telemetry`, `Content-Type: application/json`. `SITE_URL` already
  honors `RESTLESS_SITE_URL` (`lib/config.js:6`), so local dev and staging work for free.
- One request per run, at flush. Not per event — a run makes at most one telemetry call.
- `AbortSignal.timeout(1500)`. Any failure — network, non-2xx, timeout — is swallowed
  silently. No console output, no retry. This mirrors `trackDebugEvent`
  (`bin/restless.js:199`) and is the single most important rule in the whole plan:
  **telemetry must never be able to slow down, block, or break a run.**
- The payload is structurally bounded — flat fields plus at most 3 step entries, ~1 KB —
  so there is no trimming path to write. Assert the bound in a test rather than handling
  an overflow that cannot happen without a bug.

## 8. Implementation

### New files

**`lib/user-config.js`** (~70 lines) — read/write `~/.restless/config.json`.
`{ version: 1, telemetry: { enabled, notifiedAt, anonymousId } }`. Honors
`RESTLESS_CONFIG_DIR` for tests, same trick as `RESTLESS_DEBUG_DIR`. Every read is
try/catch → defaults; a corrupt or unreadable config must never be fatal. Writes are
merge-not-overwrite (`lib/cli-token.js:44` learned this the hard way) and `0600`.

**`lib/telemetry.js`** (~250 lines) — the module. Singleton buffer, exactly like
`lib/debug.js`:

```js
export function init({ argv })      // resolve enabled/debug, mint sessionId, build meta
export function isEnabled()
export function record(event, data) // push, allowlist-filtered; no-op when off
export function recordStep(step, outcome, durationMs)
export async function flush({ exitCode, outcome })  // build payload, print notice, POST
export function setStatus(enabled)  // the telemetry command's writer
export function describeStatus()    // for `telemetry status`
```

All allowlists (`COMMANDS`, `FLAGS`, `STEPS`, `CI_VENDORS`, `ERROR_CODES`) live here as
frozen `Set`s, with the "never collected" list in the module header comment. `record` is
the only way in, and it filters — so a future caller cannot smuggle a path in by passing
a bigger object.

**`schemas/telemetry.schema.json`** — the wire contract. This doubles as the handoff to
the backend agent; `plans/backend-telemetry.md` §2 references it as the source of truth.

**`tests/telemetry.test.js`** — follow the `freshEnv` re-import pattern from
`tests/env.test.js:10`, since the module caches its resolved state:

- each precedence rule in §4 wins over the ones below it
- disabled → `record` is a no-op and `flush` makes no `fetch` call at all
- `RESTLESS_TELEMETRY_DEBUG=1` → events on stderr, still no `fetch`
- an unlisted command → `unknown`; an unlisted flag → dropped
- `--dir /Users/marc/secret-repo` → payload contains neither the value nor `--dir`'s value
  anywhere (assert on the serialized JSON string, not the object)
- a `fetch` that rejects, hangs past the timeout, and returns 500 — all three leave the
  process exiting normally with the same exit code
- first-run notice fires once, and `notifiedAt` persists
- `telemetry enable` / `disable` round-trip through `RESTLESS_CONFIG_DIR`

**`tests/telemetry-schema.test.js`** — asserts the code's allowlists and the schema's
enums are the same set, in both directions. Same idea as `tests/settings-schema.test.js`:
the schema stops being documentation and starts being enforced.

**`docs/telemetry.md`** — user-facing. `docs/` is in `package.json#files`, so this ships
in the tarball and is readable offline. Content: what is collected (the §3 table), what is
never collected (the §3 list, verbatim), how to opt out (all four routes), how to see the
payload (`RESTLESS_TELEMETRY_DEBUG=1`).

### Edited files

**`lib/debug.js`** — one line. `finalize` already runs `finalizeHooks`
(`lib/debug.js:235`) but calls them synchronously, so a promise-returning hook is dropped.
Change to `await hook()`. The existing timings hook is synchronous and is unaffected. This
gives telemetry a single flush point that already covers `flushAndExit`, `beforeExit`,
`uncaughtException`, and the `SIGINT` handler (`bin/restless.js:100`) — no new exit wiring
anywhere.

**`bin/restless.js`** —
- after `debug.init` (line 50): `telemetry.init({ argv: process.argv })`, then
  `debug.addFinalizeHook(() => telemetry.flush({ ... }))`. Order matters: telemetry reads
  `debug.snapshot()` for the timing totals, so its hook must be registered after the one
  that closes open spans.
- record the `command` event next to the existing dispatch at line 310.
- new `} else if (command === 'telemetry') {` branch, next to `reset`/`clear`.
- `printHelp` (line 455): add `telemetry [status|enable|disable]` to the `rows` table and
  a one-line pointer to `docs/telemetry.md`.

**`lib/errors.js`** — `reportError` (line 18) already calls `debug.log('error', ...)`.
Add a sibling `telemetry.record('error', { code, step })`. Pass a code from the raise
site; default `unknown`. Do **not** pass `headline` or `details` — both interpolate HTTP
statuses, URLs, and server text.

**`lib/runner.js`** — the step lifecycle already lives here: it owns the `STEPS` array
(line 10), emits `debug.log('step.start', ...)`, and opens a timing span per step (line
346). Add `telemetry.recordStep(id, status, ms)` alongside those for the first three plan
steps; "Set up account" is not reported (see §3). Three call sites in one file —
`steps/*.js` stays untouched.

**`README.md`** — extend the existing `# Privacy` section (line 208). It already discloses
the registration provenance in exactly the right tone; add two bullets in the same voice,
one for what telemetry sends and one for `npx restless telemetry disable`.

### Suggested commit order

1. `lib/user-config.js` + tests — no behavior change, nothing wired.
2. `lib/telemetry.js` + `schemas/telemetry.schema.json` + both test files — still not
   wired, still no network.
3. `lib/debug.js` async hooks + `bin/restless.js` wiring.
4. Step and error instrumentation.
5. Docs, README, first-run notice.

**Do not publish to npm until `plans/backend-telemetry.md` is deployed.** Telemetry is on
by default the moment a published install runs, so a release that lands ahead of the
ingest route spends that time POSTing into a 404 — invisible, and data we cannot get
back. An earlier draft of this plan enforced that with a code-level rollout gate; that
was dropped deliberately in favour of release control, which is the owner's to manage.

`RESTLESS_TELEMETRY_FORCE=1` remains, but only for its other job: overriding the
linked-install rule (§4.5) so the real send path can be exercised from a checkout.

## 9. Decisions I need from you

1. **Anonymous, or joined to accounts?** This plan keeps telemetry strictly anonymous — no
   project id, no account id — which is what makes the "we never see your code or who you
   are" line in §3 true and simple. The cost is real: you cannot answer "did *this*
   customer's setup fail". The alternative is sending `projectId` when one exists, which
   makes the data far more useful and the privacy story longer. I'd ship anonymous first;
   joining is an additive change later, un-joining is not.
2. **Opt-out with notice, or opt-in?** Opt-out-with-notice is what Vercel, Next.js,
   Turborepo, Homebrew, and .NET all do, and opt-in telemetry in a dev CLI returns
   single-digit participation, which is worse than none. But it is a legal call, not an
   engineering one, and it should have a look from whoever owns that here.
3. **The docs URL.** The notice and `docs/telemetry.md` both need a canonical link. I have
   used `https://restless.ai/docs/telemetry` as a placeholder.
4. **Retention.** Belongs in `plans/backend-telemetry.md` §7, but it is your call, not the
   backend agent's.
5. **`setup-progress` (§2).** Do we wire the CLI up to the funnel endpoint that already
   exists, ship anonymous telemetry, or both? I'd do both — they answer different
   questions — but wiring up `setup-progress` is much the smaller change and gets a funnel
   signal without waiting on any of this.

## 10. Out of scope

- Any server-side work — schema, ingest, dashboards, retention. See
  `plans/backend-telemetry.md`.
- Telemetry in `@restlessai/sdk` (the runtime package). Different consent model entirely:
  that code runs in the customer's production server, not on a developer's laptop, and
  the answer there is almost certainly "no".
- Replacing `--debug`. The debug log stays exactly as it is; it answers a different
  question and is the thing we ask for when one specific run went wrong.
