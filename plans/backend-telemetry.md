# Plan: telemetry ingest for the Restless dashboard (backend)

**Hand this to a dedicated agent working in the dashboard repo.** It is written to stand
alone; you should not need the conversation it came from.

Companion document: `plans/cli-telemetry.md` in the `restlesshq/onboarding` repo (the
`restless` npm package) describes the client that produces this data. Read it before
writing the route — particularly §3 (what is collected) and §7 (transport).

---

## 1. Context

`npx restless init` is an AI-powered SDK installer CLI (`restlesshq/onboarding`, published
as `restless`). It runs on a developer's machine, scans their repo, generates an OpenAPI
spec, installs `@restlessai/sdk`, and registers a project against this dashboard.

It is adding anonymous usage telemetry, modelled on
[Vercel CLI Telemetry](https://vercel.com/docs/cli/about-telemetry): opt-out, disclosed on
first run, enum-only payloads, nothing that could contain code, paths, prompts, or
identities. Your job is the receiving end.

**What the CLI already does today**, which tells you the conventions to follow:

| Endpoint | Purpose |
| --- | --- |
| `POST /api/projects/init` | Registers a project from a write-key hash; returns `project_id` + `setup_key`. Already accepts `setup_source` / `setup_agent` provenance. |
| `POST /api/projects/:id/oas` | Spec upload (size-capped; the CLI mirrors the cap as `MAX_OAS_BYTES`). |
| `POST /api/projects/:id/settings`, `/sync`, `/context` | Settings + context sync, device-token authenticated. |
| `POST /api/debug` | Full debug-log upload, opt-in via `--debug`. |
| `POST /api/logs/:requestId/track` | The existing fire-and-forget event ping for the auto-fix flow. |
| `POST /api/auth/cli/start`, `GET /api/auth/cli/check` | Device-auth handshake; tokens last 24h. |

`POST /api/telemetry` is the new one. It is closest in spirit to
`/api/logs/:requestId/track` — unauthenticated, fire-and-forget, must never make a caller
wait — but it arrives once per CLI run with a batch of events instead of one ping.

**Assumptions to verify before you start** (I planned this from the CLI side and have not
read the dashboard repo):

- It is a Next.js app with App Router API routes under `app/api/`.
- There is a `projects` table whose id the dashboard calls `metricsId` and the CLI calls
  `projectId`.
- `app/src/lib/setupProvenance.ts` exists and holds the `AGENT_SLUG` regex
  (`/^[a-z0-9][a-z0-9-]{0,31}$/`) the CLI mirrors in `lib/env.js`.

If any of those are wrong, adapt and say so in your write-up — do not force the plan.

## 2. The contract

**`schemas/telemetry.schema.json` in the `restlesshq/onboarding` repo is the source of
truth for the payload.** Read it, do not reconstruct it from this document. If it does not
exist yet, the CLI work has not landed; coordinate rather than guessing a shape.

Summary, so you can start designing storage:

```jsonc
{
  "schemaVersion": 1,
  "meta": {
    "anonymousId": "uuid",       // stable per machine, random, not derived from anything
    "sessionId":   "uuid",       // per run
    "cliVersion":  "0.9.2",
    "cliName":     "restless",   // enum: restless | api | other
    "platform":    "darwin",     // process.platform
    "arch":        "arm64",
    "nodeVersion": "v20.11.0",
    "cpus":        10,
    "ci":          false,
    "ciVendor":    "github",     // enum, optional
    "source":      "agent",      // enum: cli | agent
    "agent":       "claude",     // slug or null
    "durationMs":  48213,
    "exitCode":    0,
    "outcome":     "ok"          // enum: ok | error | interrupted
  },
  "events": [
    { "event": "command", "command": "init", "flags": ["--agent"] },
    { "event": "step", "step": "generate-oas", "outcome": "ok", "durationMs": 21044 },
    { "event": "timings", "totalMs": 48213,
      "byKind": { "ai": 30112, "exec": 8020, "net": 1400, "scan": 900, "wait": 7000, "anim": 781 } },
    { "event": "detect", "language": "javascript", "framework": "fastify", "oasSourceKind": "ai" },
    { "event": "error", "code": "oas-upload-failed", "step": "generate-oas" }
  ]
}
```

Every string field above is drawn from a closed allowlist on the client. **Do not trust
that.** The client is a published npm package that anyone can fork, patch, or replay — see
§5.

There is deliberately **no project id, no account id, and no authentication**. That is the
privacy design, not an oversight: this data is anonymous and cannot be joined to a
customer. If that trade-off needs revisiting, it is a decision for the CLI owner
(`plans/cli-telemetry.md` §9.1), not something to solve by adding a field here.

## 3. The route

`POST /api/telemetry`

- **Unauthenticated.** There is nothing to authenticate against; a token would defeat the
  anonymity.
- **Always `204 No Content`**, on success *and* on rejection. Never return validation
  errors, never return a body, never return a 4xx/5xx the client can distinguish.
  Rationale: the CLI swallows every failure silently (1.5s timeout, no retry, no output),
  so a response body is unread; and an endpoint that reports *why* a payload was rejected
  is an oracle for probing the allowlists.
- **Size cap** at 256 KB request body, rejected before parse. The client caps itself at
  64 KB (`plans/cli-telemetry.md` §7); anything four times that is not our client.
- **CORS: none.** This is called by a Node process, never a browser. Do not add headers
  that let a page POST to it.
- **No cookies, no sessions.** If the framework sets one by default, strip it.
- **Do not log the raw request.** The whole point is that we hold enum data; a request log
  that captures bodies and IPs alongside it recreates exactly what we promised not to
  keep. Check whatever request-logging middleware the app has, and exclude this path
  explicitly.

Latency target: p99 under 50 ms server-side. Validate, enqueue or insert, return. If
insert is slow, buffer and write asynchronously — but do not build a queue before you have
measured that you need one.

## 4. Validation

Server-side validation is the whole security model. Three rules:

1. **Allowlist, never sanitize.** Every enum field is compared against a server-side copy
   of the allowlist. A value not in the list becomes `other` (or `unknown` for `command`)
   — it is *not* stored as-is, and it is *not* a reason to reject the row. Storing
   unrecognized strings is how a "no free text" store quietly becomes a free-text store.
2. **Type and bound everything numeric.** `cpus` 1–1024, `durationMs` 0–86,400,000,
   `exitCode` 0–255, `events` at most 200 entries. Clamp, do not reject.
3. **Drop unknown keys entirely.** Do not persist a `meta` or event object you did not
   destructure field by field. If a future client sends a field this server does not know,
   losing it is correct; storing it blind is not.

Keep the server allowlists in one module (e.g. `app/src/lib/telemetrySchema.ts`) with a
comment pointing at `schemas/telemetry.schema.json` in the CLI repo, and a test that fails
loudly when someone adds an enum value in one place only. The CLI repo does exactly this
between its own code and schema (`tests/settings-schema.test.js`); mirror the habit.

`anonymousId` and `sessionId` must both parse as UUIDs. If either does not, generate a
per-request random value instead — never store the string you were given, and never store
a null that would collapse unrelated rows into one bucket.

## 5. Abuse and integrity

The endpoint is public, unauthenticated, and its payload is a documented schema in a
public npm package. Assume all of:

- **Volume flooding.** Rate-limit by source IP — something like 60 requests/minute, 1000/
  hour — and shed above it. Honest usage is ~1 request per CLI run; a machine running
  `init` in a loop still will not approach that.
- **`anonymousId` flooding.** A single IP minting thousands of distinct `anonymousId`s is
  the shape that ruins "how many machines" as a metric. Do not try to block it inline;
  instead store the *hash* of the source IP alongside each row (see §6) so the distortion
  can be detected and excluded at query time.
- **Replay.** Identical payloads re-sent are indistinguishable from real ones, by design
  (no nonce, no auth). Deduplicate on `(sessionId, event, step)` at write time so a
  retried flush cannot double-count a step.
- **Payload-shaped attacks.** Deeply nested JSON, enormous arrays, prototype-pollution
  keys (`__proto__`, `constructor`). The size cap plus strict field-by-field
  destructuring handles all three; a schema validator that walks arbitrary input does not.

None of this needs to be perfect. It needs to be good enough that a bored person with curl
cannot silently corrupt the numbers we are about to start making decisions from.

## 6. Storage

One append-only table. Suggested shape, adapt to whatever the dashboard already uses:

```
telemetry_runs
  id                 uuid pk
  received_at        timestamptz   -- server clock; the client sends no timestamp
  anonymous_id       uuid
  session_id         uuid          -- unique index, for flush dedupe
  cli_version        text
  cli_name           text
  platform           text
  arch               text
  node_version       text
  cpus               int
  ci                 bool
  ci_vendor          text null
  source             text
  agent              text null
  duration_ms        int
  exit_code          int
  outcome            text
  ip_hash            bytea         -- see below
  events             jsonb         -- validated, allowlisted events array

  index (received_at)
  index (anonymous_id)
  index (cli_version, received_at)
```

**`ip_hash`**: `sha256(ip + daily_rotating_secret)`, never the IP itself. It exists only to
detect the flooding in §5 and it becomes useless for correlation every 24 hours. If storing
anything IP-derived is not acceptable to whoever owns privacy at ReadMe, drop the column —
the cost is losing one abuse signal, not losing the product.

Consider splitting `events` into a `telemetry_events` child table if you want per-step
funnel queries to be cheap. Start with `jsonb`; the volume is one row per CLI run, which is
small for a long time. Do not build a pipeline for data you do not have yet.

**Retention: 180 days, then hard delete.** Set this up as a scheduled job on day one, not
as a follow-up — retention that is not implemented is retention that does not exist, and
this is the kind of promise that ends up in a docs page. Confirm the number with the CLI
owner before you write it down anywhere user-facing.

## 7. What this is for

Build these five queries and confirm they are fast, before anyone asks for a dashboard.
They are the reason the feature exists:

1. **`init` funnel.** Of runs that started `init`, what fraction reached each step, and
   where do they stop? This is the single most valuable number in the dataset.
2. **Time budget.** Median `byKind` split across successful `init` runs. Tells us whether
   to optimize the AI passes, the package installs, or the waiting.
3. **Agent share.** `source` and `agent` over time. We believe most runs are agent-driven;
   this is the first time we would know.
4. **Version adoption.** `cli_version` by week — how long a released fix takes to reach
   people, and how much of the install base is on something ancient.
5. **Platform floor.** `node_version` and `platform` distribution. `package.json` declares
   `engines: >=18` and CI only exercises 20/22/24; this says whether that gap matters.

A dashboard page is nice-to-have. The queries are not.

## 8. Rollout

1. Ship the route returning `204` and writing nothing. Confirm it is reachable from a real
   `npx restless` run with `RESTLESS_SITE_URL` pointed at staging.
2. Add validation and storage. Verify with a handful of real runs, including a failing one
   and a `ctrl-c`'d one, that the rows look right.
3. Check the stored rows by hand against `plans/cli-telemetry.md` §3's "never collected"
   list. Grep a day of `events` jsonb for `/`, `\`, `=`, `http`, and anything that looks
   like a path or a key. Finding nothing is the acceptance test for this whole project.
4. Only then tell the CLI owner to flip the client default on
   (`plans/cli-telemetry.md` §8, commit 5).
5. Build the §7 queries against real data.

## 9. Do not

- Do not add authentication, a project id, or an account id to make the data more useful.
  That is a product decision with a privacy cost, and it belongs to the CLI owner.
- Do not store an unrecognized enum value "just in case".
- Do not return validation errors to the client.
- Do not let this route into the app's general request/response logging.
- Do not forward the payload to a third-party analytics vendor without asking. The CLI's
  user-facing docs will say the data goes to Restless; a vendor hop makes that untrue.
