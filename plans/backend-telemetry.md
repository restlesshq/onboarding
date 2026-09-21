# Plan: telemetry ingest for the Restless dashboard (backend)

**Hand this to a dedicated agent working in `restlesshq/app`.** It is written to stand
alone; you should not need the conversation it came from.

Companion document: `plans/cli-telemetry.md` in `restlesshq/onboarding` (the `restless` npm
package) describes the client that produces this data. Read it before writing the route —
particularly §3 (what is collected) and §7 (transport).

---

## 1. Context

`npx restless init` is an AI-powered SDK installer CLI (`restlesshq/onboarding`, published
as `restless`). It runs on a developer's machine, scans their repo, generates an OpenAPI
spec, installs `@restlessai/sdk`, and registers a project against this dashboard.

It is adding anonymous usage telemetry, modelled on
[Vercel CLI Telemetry](https://vercel.com/docs/cli/about-telemetry): opt-out, disclosed on
first run, enum-only payloads, nothing that could contain code, paths, prompts, or
identities. Your job is the receiving end plus the staff-facing view of it.

The dashboard, as of `restlesshq/app@2b34998`:

- Next.js App Router. API routes in `src/app/api/`, models in `src/models/`.
- **MongoDB via Mongoose** (`@/lib/mongoose`, `dbConnect()`). Not SQL.
- Staff pages live under `src/app/admin/*` and `src/app/debug/*`, both wrapped in
  `GodShell` (`src/components/admin/GodShell.tsx`), which gates on
  `requireStaffSessionOr404()` from `src/lib/debugAuth.ts` — a next-auth session whose
  email is in the `GODS` env var, defaulting to `greg@restless.ai`. Non-staff get a
  framework 404, never a 403, so the pages' existence stays invisible.
- `src/lib/setupProvenance.ts` holds the `AGENT_SLUG` regex the CLI mirrors in
  `lib/env.js`. `Project.metricsId` is what the CLI calls `projectId`.

The closest existing thing to what you are building is **`POST /api/debug`**
(`src/app/api/debug/route.ts`) feeding the staff page at `/debug`. Same CLI, same
unauthenticated ingest, same staff-gated read. **Read that route before writing yours** —
its header comment enumerates the exact defense-in-depth rules this plan asks for, already
implemented: 1 MB body cap rejected before parse, strict shape with everything else
dropped before storage, per-entry length clamps, no GET/LIST on the ingest path, and a
response that never echoes stored content so it cannot be used as an oracle. Your route is
that route with a different schema and tighter validation.

## 2. Read this first: the funnel already half-exists

`POST /api/projects/[projectId]/setup-progress` already exists, is tested
(`route.test.ts`), and records per-step setup funnel data onto the durable
`KeyRegistration` row. It arrived in
[restlesshq/app#240](https://github.com/restlesshq/app/pull/240), "Backend: accept setup
email + per-step progress from the CLI" (merged 2026-08-15), which was explicitly the
server half of a two-part change. `src/lib/setupProgress.ts` defines the wire contract:
`SETUP_STEPS = [welcome, generate_oas, install_sdk, test, account]`, statuses
`started | done | failed`, and `furthestKnownStep` for "how far did they get". It is
surfaced to staff today at `/admin/unclaimed`.

**The CLI never calls it, and never sent the email either.** There is no reference to
`setup-progress` anywhere in `restlesshq/onboarding`, and `registerProject` in
`lib/project-init.js` sends only `write_key_hash` + provenance — no `email`. So *both*
capabilities #240 added are unused: the optional `email` on `/api/projects/init` and the
progress endpoint. The PR's own description anticipated this ("an old CLI that sends no
email and never calls the new endpoint behaves exactly as before"), which is why nothing
broke and nobody noticed.

This matters more than anything else in this document, because it means the single most
valuable query in §7 — the `init` funnel — may not need new telemetry at all. Before you
build anything:

1. **Confirm the finding.** Re-grep both repos. If some code path does call it, most of
   this section is moot.
2. **Raise it with the CLI owner**, and settle which of the two mechanisms owns the funnel.
   They are not interchangeable:

   | | `setup-progress` | new `/api/telemetry` |
   | --- | --- | --- |
   | Auth | `setup_key`, sha256 + constant-time compare | none |
   | Identity | joined to a project and a lead email | anonymous, unjoinable |
   | Scope | `init` only, pre-claim | every command, every run |
   | Storage | `KeyRegistration.setupProgress` | new collection |

   `setup-progress` answers "did *this customer's* setup stall, and should we email them".
   Telemetry answers "what fraction of all runs stall at `install_sdk`, on which Node
   version". Both are worth having. Neither is a substitute for the other.
3. **Do not quietly reimplement one inside the other.** The likely right outcome is: wire
   the CLI up to `setup-progress` (a small change in `restlesshq/onboarding`, and it is
   already-built server capability going unused), *and* ship anonymous telemetry for the
   broader questions. But that is the CLI owner's call to make with the facts in front of
   them, not yours to assume.

If the decision is to wire up `setup-progress`, reuse `SETUP_STEPS` rather than the step
enum in `plans/cli-telemetry.md` §3 — one spelling of a step name across both systems.

## 3. The contract

**`schemas/telemetry.schema.json` in `restlesshq/onboarding` is the source of truth for
the payload.** Read it; do not reconstruct it from this document. If it does not exist
yet, the CLI work has not landed — coordinate rather than guessing a shape.

The shape is deliberately flat: **one request per run, and exactly one event type.**
Everything that happens once per run is a field, not an event. Only `steps` is a stream,
it is capped at 5, and it is populated only by `init`.

```jsonc
{
  "schemaVersion": 1,

  // identity + dedupe
  "anonymousId": "uuid",      // stable per machine, random, not derived from anything
  "sessionId":   "uuid",      // per run; dedupe key

  // what was run
  "command":   "init",        // closed enum; anything unrecognized -> "unknown"
  "flags":     ["--agent"],   // flag NAMES only, closed enum, never values
  "outcome":   "ok",          // ok | error | interrupted
  "exitCode":  0,
  "errorCode": null,          // closed enum, only when outcome=error; never a message
  "errorStep": null,
  "durationMs": 48213,
  "byKind": { "ai": 30112, "exec": 8020, "net": 1400, "scan": 900, "wait": 7000, "anim": 781 },

  // environment
  "cliVersion":  "0.9.2",
  "cliName":     "restless",  // restless | api | other
  "platform":    "darwin",
  "nodeVersion": "v20.11.0",
  "ci":          false,
  "source":      "agent",     // cli | agent  (reuse SETUP_SOURCES)
  "agent":       "claude",    // slug or null

  // detection, init only
  "language":      "javascript",
  "framework":     "fastify",
  "oasSourceKind": "ai",      // ai | native | found | file | url | describe | agent

  // the only event stream: <=3, init only
  "steps": [
    { "step": "generate_oas", "status": "done",   "durationMs": 21044 },
    { "step": "install_sdk",  "status": "failed", "durationMs": 8020 }
  ]
}
```

**`steps[].step` is a strict subset of `SETUP_STEPS` from `src/lib/setupProgress.ts`** —
just `generate_oas`, `install_sdk`, `test` — and `status` uses `SETUP_STATUSES`
(`started | done | failed`) unchanged. Import both; do not redeclare. Same for `source`,
which reuses `SETUP_SOURCES` from `src/lib/setupProvenance.ts`. This is deliberately the
same wire vocabulary `setup-progress` already speaks (§2), so the two funnels are
comparable rather than merely similar.

`SETUP_STEPS`' other two values are not sent, and you should not add them:

- **`welcome`** — redundant with the document itself. Every `init` run produces one, so
  "all `init` runs" is the funnel's denominator, and a truer one than `welcome`: it counts
  runs that died before the welcome screen, which `welcome` cannot.
- **`account`** — that step *is* the claim, and a claim creates a `Project` with a
  `metricsId`. You already know who completed, with certainty, joined to an identity. An
  anonymous self-reported copy is strictly worse data about the one step already measured
  perfectly.

So `steps` covers exactly the middle of the funnel: the part visible only from the client,
because a run that fails there never reaches this server at all.

Every string field is drawn from a closed allowlist on the client. **Do not trust that.**
The client is a published npm package that anyone can fork, patch, or replay — see §6.

There is deliberately **no project id, no account id, and no authentication**. That is the
privacy design, not an oversight. If it needs revisiting, that is a decision for the CLI
owner (`plans/cli-telemetry.md` §9.1) — and note that `setup-progress` (§2) already
covers the identified case, which is part of why this one stays anonymous.

## 4. The route

`POST /api/telemetry` → `src/app/api/telemetry/route.ts`.

Follow `src/app/api/debug/route.ts` closely. Differences:

- **Always `204 No Content`**, on success *and* on rejection. `/api/debug` returns
  `{ ok: true }`; here return nothing at all. The CLI swallows every failure silently
  (1.5s timeout, no retry, no output), so a body is unread — and an endpoint that reports
  *why* a payload was rejected is an oracle for probing the allowlists.
  (`setup-progress` uses a 400 only where it cannot depend on the projectId, for the same
  no-oracle reason. There is no such case here: return 204 unconditionally.)
- **Size cap 256 KB**, rejected before parse. The client caps itself at 64 KB
  (`plans/cli-telemetry.md` §7); `/api/debug`'s 1 MB is sized for full log uploads and is
  far too generous for enum payloads.
- **CORS: none.** Called by a Node process, never a browser.
- **No cookies, no sessions.** Strip any the framework sets by default.
- **Do not log the raw request.** The point is that we hold enum data; a request log
  capturing bodies and IPs alongside it recreates what we promised not to keep. Check the
  app's request-logging middleware and exclude this path explicitly.
- **No GET/LIST/detail on this path.** Reads happen only through the staff-gated page in
  §8, exactly as `/api/debug` and `/debug` are split today.

Latency target: p99 under 50 ms server-side. Validate, insert, return.

## 5. Validation

Server-side validation is the whole security model. Three rules:

1. **Allowlist, never sanitize.** Every enum is compared against a server-side copy of the
   list. A value not in the list becomes `other` (or `unknown` for `command`) — it is
   *not* stored as-is, and *not* a reason to reject the row. Storing unrecognized strings
   is how a "no free text" store quietly becomes a free-text store.
2. **Type and bound everything numeric.** `cpus` 1–1024, `durationMs` 0–86,400,000,
   `exitCode` 0–255, `steps` at most 3, `flags` at most 20. Clamp, do not reject. `/api/debug`'s
   `clampString` / `clampMeta` / `clampEntries` are the pattern.
3. **Drop unknown keys entirely.** Destructure field by field; never persist an object you
   did not walk. This matters more here than in `/api/debug`: that route stores
   `Schema.Types.Mixed` *by design* because the debug entry stream is heterogeneous. This
   payload is flat and closed, so nothing here is `Mixed` — see §7. Validate `byKind`'s
   keys against the closed set (`ai, exec, net, scan, wait, anim`) too; it is the one
   map-shaped field and so the one place a free-text key could sneak in.

Put the allowlists in one module, `src/lib/telemetrySchema.ts`, with a comment pointing at
`schemas/telemetry.schema.json`, and a test that fails when an enum is added in one place
only. This is the same discipline `src/lib/setupProvenance.ts` and `src/lib/setupProgress.ts`
already apply, and the CLI repo mirrors it in `tests/settings-schema.test.js`.

`anonymousId` and `sessionId` must both parse as UUIDs. If either does not, generate a
per-request random value — never store the string you were given, and never store a null
that would collapse unrelated rows into one bucket.

## 6. Abuse and integrity

The endpoint is public, unauthenticated, and its payload is a documented schema in a
public npm package. Assume all of:

- **Volume flooding.** Rate-limit by source IP — ~60/min, ~1000/hour — and shed above it.
  Honest usage is one request per CLI run.
- **`anonymousId` flooding.** One IP minting thousands of distinct ids ruins "how many
  machines". Do not block inline; store a hashed IP (§7) so it can be detected and
  excluded at query time.
- **Replay.** Identical payloads re-sent are indistinguishable from real ones by design.
  Deduplicate on `sessionId` (unique index) so a retried flush cannot double-count.
- **Payload-shaped attacks.** Deep nesting, huge arrays, `__proto__` / `constructor` keys.
  The size cap plus strict field-by-field destructuring handles all three; a validator
  that walks arbitrary input does not.

## 7. Storage

One Mongoose model, `src/models/CliTelemetry.ts`, following the conventions in
`src/models/DebugLog.ts`. Note it is flat — the payload has one event stream, so the
document has one subdocument array:

```ts
// Subset of SETUP_STEPS — see §3 for why welcome/account are excluded. Declare it
// as a filter of the imported constant, not a fresh literal, so a rename upstream
// breaks loudly here instead of silently dropping a step.
const TELEMETRY_STEPS = SETUP_STEPS.filter(
  (s) => s === "generate_oas" || s === "install_sdk" || s === "test",
);

const StepSchema = new Schema({
  step:       { type: String, enum: TELEMETRY_STEPS, required: true },
  status:     { type: String, enum: SETUP_STATUSES,  required: true },
  durationMs: { type: Number, default: 0 },
}, { _id: false });

const CliTelemetrySchema = new Schema(
  {
    anonymousId: { type: String, required: true, index: true },
    sessionId:   { type: String, required: true, unique: true },  // replay/dedupe

    command:     { type: String, default: "unknown", index: true },
    flags:       { type: [String], default: [] },
    outcome:     { type: String, enum: ["ok", "error", "interrupted"], default: "ok" },
    exitCode:    { type: Number, default: null },
    errorCode:   { type: String, default: undefined },
    errorStep:   { type: String, default: undefined },
    durationMs:  { type: Number, default: 0 },
    byKind:      { type: Map, of: Number, default: {} },   // closed key set, validated

    cliVersion:  { type: String, default: "" },
    cliName:     { type: String, default: "other" },
    platform:    { type: String, default: "" },
    nodeVersion: { type: String, default: "" },
    ci:          { type: Boolean, default: false },
    source:      { type: String, enum: SETUP_SOURCES, default: undefined },
    agent:       { type: String, default: undefined },

    language:      { type: String, default: undefined },
    framework:     { type: String, default: undefined },
    oasSourceKind: { type: String, default: undefined },

    // At most 3. NOT Mixed — unlike DebugLog.entries, this set is closed (§5.3).
    steps: { type: [StepSchema], default: [] },

    // sha256(ip + daily-rotating secret). Never the IP. Compare with
    // DebugLog.submitFingerprint, which exists for the same reason.
    submitFingerprint: { type: String, default: "" },

    expiresAt: { type: Date, required: true },   // TTL, see retention below
  },
  { timestamps: true },
);

CliTelemetrySchema.index({ createdAt: -1 });
CliTelemetrySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
```

Four of the five §8 panels read plain top-level fields, so they are ordinary aggregations
on indexed columns. Only the funnel touches `steps`. That is the payoff for keeping one
event type.

Import `SETUP_STEPS`, `SETUP_STATUSES` and `SETUP_SOURCES` rather than redeclaring them.
`TELEMETRY_STEPS` is derived from the first, never written out by hand.
The CLI derives `source` from the same `invocationSource()` these came from, and the step
vocabulary is deliberately shared with `setup-progress` (§2).

**Retention: 180 days.** Implement it as the TTL index above, set `expiresAt` at write
time, and let MongoDB sweep. This is the established pattern in the repo
(`AskAiPendingApproval`, `CliAuthToken`) and it means retention cannot silently not
happen — no cron, nothing to forget. Confirm the number with the CLI owner before it goes
in any user-facing docs page.

`submitFingerprint` exists only for the abuse detection in §6 and becomes useless for
correlation every 24 hours. If storing anything IP-derived is unacceptable to whoever owns
privacy at ReadMe, drop it — the cost is one abuse signal, not the product.

## 8. How staff see it

This is the part that makes the whole feature real; data nobody looks at is not
instrumentation, it is a liability with a retention policy.

### The page

**`/admin/telemetry`** — `src/app/admin/telemetry/page.tsx`. It gets the staff gate and
the sidebar for free: `src/app/admin/layout.tsx` wraps the entire `/admin/*` tree in
`GodShell`, which calls `requireStaffSessionOr404()`. Copy the page preamble from
`src/app/admin/signups/page.tsx`:

```ts
export const metadata: Metadata = { title: "CLI telemetry" };
export const dynamic = "force-dynamic";
export const revalidate = 0;
```

`force-dynamic` + `revalidate = 0` is not optional — every staff page in this repo sets
it so a stale CDN copy can never serve staff data to an unauthenticated viewer, as
belt-and-braces alongside the per-request session check.

Add one line to `GOD_NAV` in `src/components/admin/godNav.ts`:

```ts
{ href: "/admin/telemetry", label: "CLI telemetry", icon: "chart-line" },
```

That file is the single source of truth for staff destinations — it feeds the godmode
sidebar and both account menus, so one line makes the page discoverable everywhere at
once. Pick an `IconName` that actually exists in `@/components/icon/generated-icons`.

### What's on it

A server component doing Mongo aggregations directly — no API route, no client fetching.
`await requireStaffSessionOr404()`, `await dbConnect()`, then one aggregate per panel.
Time range from `searchParams` (`?days=7|30|90`, default 30).

Five panels, matching the five questions the data exists to answer:

1. **`init` funnel** — of all documents with `command: "init"`, the share reaching each of
   the three steps, and where they stop. The denominator is the document count, not a
   `welcome` step (§3). The single most valuable number here. Cross-check the tail against
   claimed `Project` records and against `/admin/unclaimed` (§2) — if they disagree, one
   of them is wrong and that is worth knowing.
2. **Time budget** — median `byKind` split across successful `init` runs. Says whether to
   optimize AI passes, package installs, or the waiting.
3. **Agent share** — `source` and `agent` over time. We believe most runs are
   agent-driven; this is the first time we would know.
4. **Version adoption** — `cliVersion` by week. How long a released fix takes to reach
   people, and how much of the install base is on something ancient.
5. **Platform floor** — `nodeVersion` and `platform` distribution. `package.json` declares
   `engines: >=18` while CI only exercises 20/22/24; this says whether that gap matters.

**There is no chart library in this app** — I checked `package.json`, there is no
recharts/chart.js/visx/d3/nivo. Do not add one for a staff page. Every panel here is a
ranked list with a magnitude, which is a table plus a `<div>` whose width is a
percentage. That is how `/admin/signups` and `/debug` already render, it matches
`godTheme.ts`, and it has no bundle cost. If someone later wants real charts, that is a
separate conversation with a real justification.

### The drill-down

**`/admin/telemetry/runs`** — recent raw runs, newest first, modelled on
`src/app/debug/page.tsx` (which does exactly this for debug uploads: `.find({}).sort({
createdAt: -1 }).limit(200).lean()`, rendered as a table with `LocalTime`).

This is not just for curiosity. It is **the acceptance test surface for the privacy
promise**: a staff member can open it and see, field by field, that nothing in there is a
path, a prompt, or a key. Make the raw stored document viewable for a single run. If that
page ever shows something that looks like a file path, the CLI has a bug and this is where
we find out.

### What not to build

- **Not Grafana.** ReadMe's Grafana org is a separate company's observability stack. It is
  out of scope for Restless — do not send data to it, build dashboards in it, or read from
  it, and do not treat it as a future option to revisit.
- **Not a third-party analytics vendor.** See §10.
- **Not alerting, yet.** Nobody knows what normal looks like. Get a month of data first.

Ad-hoc questions get answered by querying Mongo directly. The page exists for the
recurring five.

## 9. Rollout

1. Settle §2 with the CLI owner. It may change what you build.
2. Ship the route returning `204` and writing nothing. Confirm it is reachable from a real
   `npx restless` run with `RESTLESS_SITE_URL` pointed at staging.
3. Add validation and the model. Verify with real runs — including a failing one and a
   `ctrl-c`'d one — that the documents look right.
4. Build `/admin/telemetry/runs` **before** the aggregate page, and check a day of stored
   documents by hand against `plans/cli-telemetry.md` §3's never-collected list. Grep the stored
   documents for `/`, `\`, `=`, `http`, and anything path- or key-shaped. Finding nothing
   is the acceptance test for this whole project.
5. Only then tell the CLI owner to flip the client default on
   (`plans/cli-telemetry.md` §8, commit 5).
6. Build the five panels against real data.

## 10. Do not

- Do not add authentication, a project id, or an account id to make the data more useful.
  That is a product decision with a privacy cost, it belongs to the CLI owner, and §2 is
  probably the real answer to whatever prompted it.
- Do not store an unrecognized enum value "just in case".
- Do not return validation errors to the client.
- Do not use `Schema.Types.Mixed` anywhere in this model. `DebugLog` does, deliberately,
  because its entry stream is open-ended. This schema is closed and must stay closed.
- Do not let this route into the app's general request/response logging.
- Do not forward the payload to a third-party analytics vendor without asking. The CLI's
  user-facing docs will say the data goes to Restless; a vendor hop makes that untrue.
