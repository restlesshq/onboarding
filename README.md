# npx restless init

Restless makes sure every 🔴 400 Bad Request turns out 🟢 200 Okay.

It's not just another observability platform (although you can use it to see what your users are up to!).

Think of us more as an API success platform. We give humans, AI and you the tools to quickly make successful calls.

# Supported stacks

| language | frameworks |
| --- | --- |
| JavaScript / TypeScript | Express, Fastify, Koa, Hono, NestJS, Next.js (App or Pages Router) |
| Python | Flask, Django, FastAPI, Starlette, and anything else speaking WSGI or ASGI |
| Ruby | Rails, Sinatra, Hanami, Grape, Roda, and anything else speaking Rack |
| Go | net/http, chi, gorilla/mux, Echo, Gin |

A repo can hold more than one. A Django API behind a Next.js frontend is two
real APIs, and setup scans for both and asks which you meant rather than
picking for you.

If `npx restless init` finds only a language we can't wire yet (a `composer.json`,
`Cargo.toml`, `pom.xml`, and so on) it tells you and stops
rather than scanning a codebase it can't set up. The call it prints is the
fastest way to get your language moved up.

That check only fires when there is nothing supported to find, so a Python API
with a `package.json` for its frontend, or a Node API with Python build
scripts, are both unaffected. If it does misjudge your repo - an HTTP framework
we don't know by name, or a bare `node:http` server we couldn't see - skip it
and scan anyway:

```
RESTLESS_SKIP_STACK_CHECK=1 npx restless init
```

# What lands in your project

 - `.restless/` - your API's OpenAPI spec plus the settings the SDK reads at
   startup. **Commit it with your code.** It's configuration, not a build
   artifact, and it holds no credentials.
 - `RESTLESS_KEY` in `.env` - your project's write key. Keep this out of git.

# A spec split across files

If your spec pulls parts of itself in from other files with `$ref`
(`$ref: ./paths/users.yaml`), the CLI bundles those in before it uploads, so the
dashboard gets one complete spec. Your files stay as they are. A spec with no
external refs is uploaded exactly as written. If a ref points at a file that
isn't there, setup says which one when you pick the spec, rather than uploading
a spec with holes in it.

# One API, several spec files

A Restless project is one API with one spec. If yours is split across several
spec files, setup lists "Combine your specs into one" as the last choice
whenever it finds more than one (picking a single spec is still the default).
Untick any that aren't part of this API, such as test fixtures, and it writes
the combined spec to `.restless/openapi.json`. Your files are only ever read.

 - Each one is bundled first if it's split across files with `$ref`s.
 - Swagger 2.0 is converted to OpenAPI 3.0, so it can be combined with OpenAPI 3.0 specs.
 - A component defined differently in two files is renamed with the file's name
   (`Error` in `billing.yaml` becomes `BillingError`), and setup lists every rename.
 - It refuses, and tells you why, when two files define the same endpoint, point
   at different servers (those are separate APIs, so set each up on its own), or
   mix OpenAPI 3.0 and 3.1.

`npx restless update` re-combines the same files the next time you refresh.

# Running inside a coding agent

If you run `npx restless init` inside Claude Code or Codex, it doesn't quietly drive
its own AI through your codebase. It prints the setup as instructions for the
agent you're already talking to, so the work happens in front of you: you see
every diff and can stop or redirect it. Your agent handles reading the code,
writing the spec, and wiring the middleware; these commands cover the parts
that shouldn't be improvised:

| command | what it does |
| ------- | ------------ |
| `npx restless guide [oas\|sdk]` | Prints the spec-writing / SDK-wiring instructions |
| `npx restless key` | Registers the project and writes `RESTLESS_KEY` to `.env` |
| `npx restless register --oas <file>` | Records a spec in `.restless/settings.json` (rejects localhost servers) |
| `npx restless verify --url <url>` | Sends one request, confirms the SDK saw it, the log landed, and no owner-id placeholder remains |
| `npx restless login` | Prints the URL you open to claim the project |

Re-running is safe: an unchanged key keeps its existing project rather than
registering a new one - even when `.restless/` is gone, `npx restless key` re-adopts
the project this machine first registered the key to, and if the key on disk
can't be matched to any known project it mints a fresh key (replacing the `.env`
line) instead of re-registering the old one into a project its logs would never
reach. It writes the key straight to `.env` and never echoes it into the agent's
transcript; `--inline` prints it on stdout instead, but only for humans - under
a coding agent it refuses. It also reports whether git ignores that env file
(`envIgnoredByGit`), so the key can't slip into a commit unnoticed.

**Not Claude Code or Codex?** Those two announce themselves in the environment;
everything else we infer from a run whose input and output are both pipes,
which is what an agent's shell tool looks like. That's enough to hand over the
playbook instead of driving your repo from a hidden sub-agent, but it can't
tell us *which* tool you are - so name yourself and it gets recorded on the
project: `--agent cursor` on any command, or `RESTLESS_AGENT=cursor` in the
environment. Piping on purpose as a human? `RESTLESS_INTERACTIVE=1` opts back
out.

Running in a plain terminal? Setup asks whether it can use your local agent.
Answer "No, other options" to copy that same prompt for an agent elsewhere, set
it up by hand with the commands above, book a call, or ask questions first.

Want the guided flow instead, with the CLI doing the work? `npx restless init --self-drive`.

# After you've claimed a project

`npx restless init` stays safe to re-run, and it notices what's already there: an API
you've mapped is offered back to you instead of being re-scanned, and a project
you've already claimed finishes without asking you to claim it a second time.

Changing things afterwards is `npx restless update`, not another `init`. It edits
settings (name, base URL, visibility, request prefix) and refreshes your spec,
then pushes both to the dashboard.

Refreshing means whatever it meant the first time, because setup records where
your spec came from:

| your spec came from | what "refresh" does | checked automatically |
| ------------------- | ------------------- | --------------------- |
| a URL | re-fetches that URL | yes |
| a file you maintain | re-reads it. We never regenerate over your file | yes |
| a command or location you described | runs that again | yes |
| several specs you combined | re-reads and re-combines them | yes |
| your framework's generator | runs it again, then fills gaps from your routes | yes |
| our AI reading your routes | reads them again | on request |

Anything with a source to go back to gets checked before `update` asks you
anything, so it opens with whether your spec actually changed:

```
$ npx restless update
  Your spec changed (3 endpoints now)

    + GET /pets/{id}
    + POST /pets

  Update the spec and sync your settings? [Y/n]
```

Say no and you get the full menu instead.

Nothing touches your spec before you answer, on any path through `update`: every
refresh - re-fetching a URL, replaying a recorded command, regenerating from your
routes - is written to a scratch directory and only moved into place once you
agree. If it fails, or you say no, the file you already had is exactly as it was.

It checks the dashboard too, which is the other way a spec goes out of date:

```
$ npx restless update
  ! Your dashboard is missing 2 endpoints that your spec has:
    + GET /api/v1/projects/{}/feedback
    + PATCH /api/v1/projects/{}/feedback/{}

  Your local .restless/openapi.json is already up to date.

  Push it to the dashboard? [Y/n]
```

Those are separate questions. Your local file can be perfectly current while the
dashboard serves something from weeks ago, and that's the one you notice, because
it's what your docs and AI chat answer from. Comparing needs an authorized
session, so if this machine hasn't been authorized yet the check says so instead
of guessing.

When there's genuinely nothing to do, it says so and ends:

```
  ✓ Your spec is unchanged (34 endpoints).
  ✓ Your dashboard is serving this version.

  Press Enter to exit, or s to edit settings.
```

The exception is a spec our AI wrote from your routes. There's no source to go
back to, so re-checking it means reading your whole codebase again from scratch
- a decision rather than a status check. You'll see what you have and can ask
for that explicitly.

If a refresh would remove endpoints from your docs, it says so and asks.
Regenerating from your routes is always available as an explicit choice, and it
writes to `.restless/openapi.json` rather than overwriting a spec you wrote
yourself - when that changes which file your project points at, the confirm says
so before you answer, not afterwards.

`update` also runs without prompts when you tell it exactly what to do, which is
what a coding agent or a CI job needs. Run it inside Claude Code or Codex with
no flags and it prints these rather than trying to drive a picker nobody can
answer:

```
npx restless update --status --json     # did the spec change? writes nothing
npx restless update --refresh --json    # re-run its source, then push spec + settings
npx restless update --oas <file|url>    # point at a different spec and push it
npx restless update --base-url https://api.acme.com
npx restless update --sync              # push settings with no edits
```

Also `--name`, `--internal` / `--external`, `--prefix`, and `--project <id>` to
pick one API in a multi-API repo.

`--status` is the read-only one: no writes, nothing pushed. It answers two
separate questions, because they have different answers:

```json
{
  "specChanged": false,
  "dashboard": { "behind": true, "missing": ["GET /api/v1/projects/{}/feedback"] }
}
```

`specChanged` is "is my local file stale against its own source". `dashboard` is
"is what Restless serves stale against my local file". It never triggers a
browser login, so `dashboard.status` is `unauthorized` when this machine has no
session yet.

It's deliberately narrower than what the interactive flow checks. A URL or a
file it can answer instantly; re-running a recorded command or a framework
generator needs an agent, and having a status check spawn one defeats the point
of asking first. Those report `checkable: false` and point at `--refresh`, which
is the explicit "yes, do the expensive thing".

Local edits are saved before anything is pushed, so a sync that can't reach us
never discards them: `--json` reports `synced` separately from `ok` and says why.
Authorizing a machine needs a browser once; after that the session is reused for
24 hours.

# Privacy

 - The setup will use AI, but won't use it without asking first.
 - It uses your local AI, so no code will be sent to our servers.
 - Inside a coding agent, the AI doing the work is the one you're already
   using, and nothing extra is spawned behind your back.
 - Registering a project records two things about how setup ran: whether you
   started it yourself or your coding agent did, and which agent did the work
   (`--agent` / `RESTLESS_AGENT` if you set one, otherwise blank unless it's
   Claude Code or Codex). That's it - no prompts, no code, no file contents.
 - The CLI sends anonymous usage data once per run: which command you ran, how
   it ended, how long it took, and how far setup got. No paths, no code, no
   prompts, and nothing tied to your account. Turn it off with
   `npx restless telemetry disable` (or `DO_NOT_TRACK=1`), see exactly what
   would be sent with `RESTLESS_TELEMETRY_DEBUG=1`, and read the full list in
   [docs/telemetry.md](docs/telemetry.md).
